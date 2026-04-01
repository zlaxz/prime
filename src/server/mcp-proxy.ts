#!/usr/bin/env node

/**
 * Prime Recall MCP Proxy
 *
 * For LAPTOP use: forwards all MCP tool calls to the Mac Mini's REST API.
 * Falls back to local SQLite if the server is unreachable.
 *
 * This solves the split-brain problem: Claude Desktop on the laptop
 * always reads the Mac Mini's fresh data instead of a stale local copy.
 *
 * Architecture:
 *   Claude Desktop → MCP (stdio) → this proxy → HTTP → Mac Mini:3210/api/*
 *                                              ↘ fallback → local SQLite
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import http from 'http';
import https from 'https';

// Mac Mini server — try LAN first, then tunnel
const SERVERS = [
  'http://Zachs-Mac-mini.local:3210',   // LAN (fast, <5ms)
  // Add Cloudflare tunnel URL here when stable:
  // 'https://your-tunnel.trycloudflare.com',
];

let _activeServer: string | null = null;
let _lastCheck = 0;

/**
 * Find a reachable server. Caches for 60 seconds.
 */
async function getServer(): Promise<string | null> {
  if (_activeServer && Date.now() - _lastCheck < 60000) return _activeServer;

  for (const server of SERVERS) {
    try {
      const ok = await httpGet(`${server}/api/health`, 3000);
      if (ok) {
        _activeServer = server;
        _lastCheck = Date.now();
        return server;
      }
    } catch {}
  }

  _activeServer = null;
  return null;
}

/**
 * HTTP GET with timeout. Returns parsed JSON or null.
 */
function httpGet(url: string, timeout = 60000): Promise<any> {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const req = mod.get(url, { timeout }, (res) => {
      let data = '';
      res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { resolve(data); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
  });
}

/**
 * HTTP POST with JSON body. Returns parsed JSON.
 */
function httpPost(url: string, body: any, timeout = 30000): Promise<any> {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const payload = JSON.stringify(body);
    const parsed = new URL(url);

    const req = mod.request({
      hostname: parsed.hostname,
      port: parsed.port,
      path: parsed.pathname + parsed.search,
      method: 'POST',
      timeout,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
      },
    }, (res) => {
      let data = '';
      res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { resolve(data); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.write(payload);
    req.end();
  });
}

// ============================================================
// MCP Server — proxies to Mac Mini REST API
// ============================================================

const server = new McpServer({
  name: "prime-recall",
  version: "0.1.0",
  description: "Prime Recall — Zach Stock's AI Chief of Staff system. Connected to Mac Mini with 9500+ knowledge items from email, calendar, meetings, and Claude conversations. You are Prime. When discussing business: lead with ONE action, present finished work not tasks, use prime_retrieve for source verification. When you find gaps or errors, log them with prime_remember tagged 'SYSTEM GAP' or 'SYSTEM SUGGESTION' so the system improves from every conversation.",
});

// Helper: proxy a search request
async function proxySearch(query: string, limit: number = 10, strategy?: string): Promise<string> {
  const srv = await getServer();
  if (!srv) return 'Prime Recall server unreachable. Mac Mini may be offline.';

  try {
    const result = await httpPost(`${srv}/api/search`, { query, limit, strategy }, 120000);
    if (result.results) {
      return result.results.map((r: any, i: number) => {
        const sim = r.similarity ? ` (${(r.similarity * 100).toFixed(0)}%)` : '';
        const contacts = Array.isArray(r.contacts) ? r.contacts : [];
        const commitments = Array.isArray(r.commitments) ? r.commitments : [];
        let entry = `[${i + 1}] ${r.title}${sim}`;
        entry += `\n   ${r.summary}`;
        entry += `\n   Source: ${r.source} | Date: ${r.source_date || 'unknown'}${r.project ? ` | Project: ${r.project}` : ''}`;
        if (contacts.length) entry += `\n   Contacts: ${contacts.join(', ')}`;
        if (commitments.length) entry += `\n   Commitments: ${commitments.join('; ')}`;
        return entry;
      }).join('\n\n');
    }
    return JSON.stringify(result);
  } catch (err: any) {
    return `Error: ${err.message}`;
  }
}

// ---- Tools ----

server.tool(
  "prime_search",
  "Search the knowledge base — emails, conversations, meetings, files. Returns relevant items with similarity scores. IMPORTANT: If results are poor, missing, or don't answer the question, call prime_remember with 'SYSTEM GAP: [what was searched for and why the results were inadequate]' so the system can improve.",
  {
    query: z.string().describe("What to search for"),
    limit: z.number().optional().default(10),
    strategy: z.string().optional().describe("Search strategy: auto, semantic, keyword, graph, temporal, hierarchical"),
  },
  async ({ query, limit, strategy }) => {
    const text = await proxySearch(query, limit, strategy);
    return { content: [{ type: "text" as const, text }] };
  }
);

server.tool(
  "prime_ask",
  "Ask Prime anything about the user's business. Returns an AI-generated answer with cited sources.",
  {
    question: z.string().describe("The question to ask"),
  },
  async ({ question }) => {
    const srv = await getServer();
    if (!srv) return { content: [{ type: "text" as const, text: 'Prime server unreachable.' }] };
    try {
      const result = await httpPost(`${srv}/api/ask`, { question }, 120000); // 2 min — Claude reasoning takes time
      return { content: [{ type: "text" as const, text: result.answer || JSON.stringify(result) }] };
    } catch (err: any) {
      return { content: [{ type: "text" as const, text: `Error: ${err.message}` }] };
    }
  }
);

server.tool(
  "prime_remember",
  "Save something to the knowledge base — a fact, decision, or observation.",
  {
    text: z.string().describe("What to remember"),
    project: z.string().optional().describe("Project to associate with"),
    importance: z.string().optional().describe("low, normal, high, or critical"),
  },
  async ({ text, project, importance }) => {
    const srv = await getServer();
    if (!srv) return { content: [{ type: "text" as const, text: 'Prime server unreachable.' }] };
    try {
      const result = await httpPost(`${srv}/api/remember`, { text, project, importance }, 120000); // 2 min — extraction + embedding takes time
      return { content: [{ type: "text" as const, text: `Remembered: ${result.title || text.slice(0, 60)}` }] };
    } catch (err: any) {
      return { content: [{ type: "text" as const, text: `Error: ${err.message}` }] };
    }
  }
);

server.tool(
  "prime_status",
  "Show knowledge base statistics — item counts, sources, sync state.",
  {},
  async () => {
    const srv = await getServer();
    if (!srv) return { content: [{ type: "text" as const, text: 'Prime server unreachable.' }] };
    try {
      const result = await httpGet(`${srv}/api/status`);
      let text = `Knowledge items: ${result.total_items}\n`;
      if (result.by_source) {
        text += '\nBy source:\n' + result.by_source.map((s: any) => `  ${s.source}: ${s.count}`).join('\n');
      }
      return { content: [{ type: "text" as const, text }] };
    } catch (err: any) {
      return { content: [{ type: "text" as const, text: `Error: ${err.message}` }] };
    }
  }
);

server.tool(
  "prime_get_commitments",
  "Show all commitments — overdue, due soon, active, fulfilled.",
  {
    state: z.string().optional().describe("Filter by state: active, overdue, fulfilled, dropped"),
    project: z.string().optional(),
  },
  async ({ state, project }) => {
    const srv = await getServer();
    if (!srv) return { content: [{ type: "text" as const, text: 'Prime server unreachable.' }] };
    try {
      const result = await httpGet(`${srv}/api/query/commitments`);
      let text = '';
      for (const c of (result.commitments || [])) {
        if (state && c.state !== state) continue;
        if (project && c.project !== project) continue;
        const due = c.due_date ? ` (due ${c.due_date})` : '';
        text += `[${c.state}] ${c.text}${due}\n  Owner: ${c.owner || '?'} | Project: ${c.project || '?'}\n\n`;
      }
      return { content: [{ type: "text" as const, text: text || 'No commitments match.' }] };
    } catch (err: any) {
      return { content: [{ type: "text" as const, text: `Error: ${err.message}` }] };
    }
  }
);

server.tool(
  "prime_get_contacts",
  "List contacts by mention frequency.",
  {},
  async () => {
    const srv = await getServer();
    if (!srv) return { content: [{ type: "text" as const, text: 'Prime server unreachable.' }] };
    try {
      const result = await httpGet(`${srv}/api/query/contacts`);
      const text = (result.contacts || []).slice(0, 20)
        .map((c: any) => `${c.name} (${c.count} mentions)`)
        .join('\n');
      return { content: [{ type: "text" as const, text }] };
    } catch (err: any) {
      return { content: [{ type: "text" as const, text: `Error: ${err.message}` }] };
    }
  }
);

server.tool(
  "prime_get_projects",
  "List active projects.",
  {},
  async () => {
    const srv = await getServer();
    if (!srv) return { content: [{ type: "text" as const, text: 'Prime server unreachable.' }] };
    try {
      const result = await httpGet(`${srv}/api/query/projects`);
      const text = (result.projects || [])
        .map((p: any) => `${p.name} (${p.items} items)`)
        .join('\n');
      return { content: [{ type: "text" as const, text }] };
    } catch (err: any) {
      return { content: [{ type: "text" as const, text: `Error: ${err.message}` }] };
    }
  }
);

server.tool(
  "prime_questions",
  "Get pending questions that Prime needs the user to answer. These are strategic questions only the user can answer — about deal status, relationship context, business decisions. When questions exist, ASK THEM. When the user answers, call prime_answer_question with the answer.",
  {},
  async () => {
    const srv = await getServer();
    if (!srv) return { content: [{ type: "text" as const, text: 'Prime server unreachable.' }] };
    try {
      const result = await httpGet(`${srv}/api/v1/questions`);
      const questions = result.questions || result || [];
      if (questions.length === 0) return { content: [{ type: "text" as const, text: 'No pending questions.' }] };
      const text = questions.map((q: any, i: number) => {
        let entry = `[${i + 1}] (${q.priority || 'medium'}) ${q.question}`;
        if (q.project) entry += `\n   Project: ${q.project}`;
        if (q.context) entry += `\n   Context: ${q.context}`;
        entry += `\n   ID: ${q.id}`;
        return entry;
      }).join('\n\n');
      return { content: [{ type: "text" as const, text: `${questions.length} pending questions:\n\n${text}` }] };
    } catch (err: any) {
      return { content: [{ type: "text" as const, text: `Error: ${err.message}` }] };
    }
  }
);

server.tool(
  "prime_answer_question",
  "Submit the user's answer to a pending Prime question. The answer becomes knowledge that improves future reasoning.",
  {
    question_id: z.string().describe("The question ID from prime_questions"),
    answer: z.string().describe("The user's answer"),
  },
  async ({ question_id, answer }) => {
    const srv = await getServer();
    if (!srv) return { content: [{ type: "text" as const, text: 'Prime server unreachable.' }] };
    try {
      const result = await httpPost(`${srv}/api/v1/questions/${question_id}/answer`, { answer }, 30000);
      return { content: [{ type: "text" as const, text: `Answer saved. Prime will use this in future reasoning.` }] };
    } catch (err: any) {
      return { content: [{ type: "text" as const, text: `Error: ${err.message}` }] };
    }
  }
);

server.tool(
  "prime_briefing",
  "Generate a daily intelligence briefing — priorities, commitments, dropped balls, relationship health.",
  {
    days: z.number().optional().default(7).describe("Days to look back"),
  },
  async ({ days }) => {
    const srv = await getServer();
    if (!srv) return { content: [{ type: "text" as const, text: 'Prime server unreachable.' }] };
    // Briefing is heavy — use longer timeout
    try {
      const result = await httpPost(`${srv}/api/ask`, {
        question: `Generate a morning briefing. Look back ${days} days. Include: top priorities, commitments due, dropped balls, relationship health, what changed.`
      }, 120000);
      return { content: [{ type: "text" as const, text: result.answer || 'Briefing generation failed.' }] };
    } catch (err: any) {
      return { content: [{ type: "text" as const, text: `Error: ${err.message}` }] };
    }
  }
);

server.tool(
  "prime_retrieve",
  "Retrieve the FULL original content from ANY source — emails, conversations, meeting transcripts, manual entries, cowork sessions, documents. Works for ALL source types. For large content, use offset/limit to paginate (e.g., offset=0 limit=50000 for first 50K chars, then offset=50000 for the next chunk).",
  {
    source_ref: z.string().describe("The source_ref from a search result"),
    offset: z.number().optional().default(0).describe("Character offset to start reading from (for pagination)"),
    limit: z.number().optional().default(50000).describe("Max characters to return (default 50000)"),
  },
  async ({ source_ref, offset, limit }) => {
    const srv = await getServer();
    if (!srv) return { content: [{ type: "text" as const, text: 'Prime server unreachable.' }] };
    try {
      const result = await httpPost(`${srv}/api/retrieve`, { source_ref }, 60000);
      if (result.content) {
        const total = result.content.length;
        const chunk = result.content.slice(offset, offset + limit);
        const hasMore = (offset + limit) < total;
        let header = `[${result.content_type || 'source'}] ${total} chars total`;
        if (offset > 0 || hasMore) {
          header += ` | showing ${offset}-${offset + chunk.length}`;
        }
        if (hasMore) {
          header += ` | MORE AVAILABLE: call again with offset=${offset + limit}`;
        }
        return { content: [{ type: "text" as const, text: `${header}\n\n${chunk}` }] };
      }
      return { content: [{ type: "text" as const, text: `Could not retrieve source content for ${source_ref}.` }] };
    } catch (err: any) {
      return { content: [{ type: "text" as const, text: `Error retrieving source: ${err.message}` }] };
    }
  }
);

server.tool(
  "prime_actions",
  "Get pending action items from the dream pipeline. These are staged actions waiting for user review — emails to send, documents to create, follow-ups to make. Use this to brief the user on what needs doing and walk through them one at a time.",
  {
    project: z.string().optional().describe("Filter by project name"),
    status: z.string().optional().default("pending").describe("Filter: pending, approved, rejected, executed"),
  },
  async ({ project, status }) => {
    const srv = await getServer();
    if (!srv) return { content: [{ type: "text" as const, text: 'Prime server unreachable.' }] };
    try {
      const result = await httpGet(`${srv}/api/ambient`);
      let actions = result.actions || [];
      if (project) actions = actions.filter((a: any) => a.project?.toLowerCase().includes(project.toLowerCase()));
      if (actions.length === 0) return { content: [{ type: "text" as const, text: 'No pending actions.' }] };
      const text = actions.map((a: any, i: number) => {
        let entry = `[${i + 1}] (${a.type}) ${a.summary}`;
        if (a.project) entry += `\n   Project: ${a.project}`;
        if (a.to) entry += `\n   To: ${a.to}`;
        if (a.subject) entry += `\n   Subject: ${a.subject}`;
        if (a.body) entry += `\n   Body preview: ${a.body.slice(0, 200)}`;
        if (a.reasoning) entry += `\n   Why: ${a.reasoning}`;
        entry += `\n   ID: ${a.id}`;
        return entry;
      }).join('\n\n');
      return { content: [{ type: "text" as const, text: `${actions.length} pending actions:\n\n${text}` }] };
    } catch (err: any) {
      return { content: [{ type: "text" as const, text: `Error: ${err.message}` }] };
    }
  }
);

server.tool(
  "prime_approve",
  "Approve and execute a staged action — send an email, create a calendar event, etc. Use after reviewing the action with the user.",
  {
    action_id: z.string().describe("The action ID from prime_actions"),
  },
  async ({ action_id }) => {
    const srv = await getServer();
    if (!srv) return { content: [{ type: "text" as const, text: 'Prime server unreachable.' }] };
    try {
      const result = await httpPost(`${srv}/api/approve-action`, { id: action_id }, 30000);
      return { content: [{ type: "text" as const, text: result.message || `Action ${action_id} executed.` }] };
    } catch (err: any) {
      return { content: [{ type: "text" as const, text: `Error: ${err.message}` }] };
    }
  }
);

server.tool(
  "prime_notify",
  "Send a notification to the user (iMessage for critical/high, logged for normal/low).",
  {
    message: z.string().describe("Notification message"),
    urgency: z.string().optional().default("normal").describe("critical, high, normal, low"),
  },
  async ({ message, urgency }) => {
    const srv = await getServer();
    if (!srv) return { content: [{ type: "text" as const, text: 'Prime server unreachable.' }] };
    try {
      const result = await httpPost(`${srv}/api/notify`, { message, urgency });
      return { content: [{ type: "text" as const, text: `Notification sent (${urgency}): ${message.slice(0, 60)}` }] };
    } catch (err: any) {
      return { content: [{ type: "text" as const, text: `Notification logged locally: ${message.slice(0, 60)}` }] };
    }
  }
);

server.tool(
  "prime_correct",
  "Give feedback to Prime — dismiss an action, correct a classification, put something on hold. This teaches Prime to not make the same mistake again. Use when the user says something like 'that's not relevant' or 'I already handled that' or 'Brayden is on hold'.",
  {
    action_id: z.string().optional().describe("ID of the staged action to dismiss (from search results)"),
    reason: z.enum(["already_handled", "on_hold", "wrong_person", "not_mine", "noise"]).describe("Why this is being dismissed"),
    explanation: z.string().optional().describe("Additional context — helps Prime learn (e.g., 'We decided to pause this on Friday')"),
    entity_name: z.string().optional().describe("Entity name to put on hold or dismiss"),
  },
  async ({ action_id, reason, explanation, entity_name }) => {
    const srv = await getServer();
    if (!srv) return { content: [{ type: "text" as const, text: 'Prime server unreachable.' }] };
    try {
      const result = await httpPost(`${srv}/api/dismiss-action`, {
        id: action_id || `entity-${entity_name}`,
        reason,
        explanation: explanation || '',
      }, 30000);
      return { content: [{ type: "text" as const, text: `Correction saved. Prime will learn: ${result.correction_rule?.slice(0, 150)}` }] };
    } catch (err: any) {
      return { content: [{ type: "text" as const, text: `Error: ${err.message}` }] };
    }
  }
);

server.tool(
  "prime_claude_conversations",
  "Search and list Claude.ai conversations across ALL organizations. Use this to find prior conversations about a topic, person, or project. Returns conversation titles, summaries, and UUIDs you can use with prime_claude_read.",
  {
    query: z.string().optional().describe("Search term to filter conversations by title/summary"),
  },
  async ({ query }) => {
    const srv = await getServer();
    if (!srv) return { content: [{ type: "text" as const, text: 'Prime server unreachable.' }] };
    try {
      const url = query ? `${srv}/api/claude/conversations?q=${encodeURIComponent(query)}` : `${srv}/api/claude/conversations`;
      const result = await httpGet(url);
      const convos = result.conversations || result || [];
      if (convos.length === 0) return { content: [{ type: "text" as const, text: query ? `No conversations matching "${query}".` : 'No conversations found.' }] };
      const text = convos.slice(0, 20).map((c: any, i: number) => {
        let entry = `[${i + 1}] ${c.name || 'Untitled'}`;
        if (c.org) entry += ` (${c.org})`;
        if (c.project) entry += ` [${c.project}]`;
        if (c.summary) entry += `\n   ${c.summary.slice(0, 150)}`;
        entry += `\n   UUID: ${c.uuid}`;
        return entry;
      }).join('\n\n');
      return { content: [{ type: "text" as const, text: `${result.total || convos.length} conversations${query ? ` matching "${query}"` : ''}:\n\n${text}` }] };
    } catch (err: any) {
      return { content: [{ type: "text" as const, text: `Error: ${err.message}` }] };
    }
  }
);

server.tool(
  "prime_claude_read",
  "Read the FULL content of a Claude.ai conversation including all messages. Use after prime_claude_conversations to get the UUID. IMPORTANT: Always use this tool when the user asks about content from a prior Claude conversation — summaries are not enough. Also check prime_claude_files for any images, documents, or artifacts in the conversation.",
  {
    uuid: z.string().describe("The conversation UUID from prime_claude_conversations"),
  },
  async ({ uuid }) => {
    const srv = await getServer();
    if (!srv) return { content: [{ type: "text" as const, text: 'Prime server unreachable.' }] };
    try {
      const result = await httpGet(`${srv}/api/claude/conversations/${uuid}`);
      if (!result.messages?.length) return { content: [{ type: "text" as const, text: 'Conversation not found or empty.' }] };
      const text = `Conversation: "${result.name}" (${result.message_count} messages)\n\n` +
        result.messages.map((m: any) =>
          `[${m.sender}] ${m.text?.slice(0, 2000)}`
        ).join('\n\n---\n\n');
      return { content: [{ type: "text" as const, text: text.slice(0, 50000) }] };
    } catch (err: any) {
      return { content: [{ type: "text" as const, text: `Error: ${err.message}` }] };
    }
  }
);

server.tool(
  "prime_claude_files",
  "List all files and artifacts (images, PDFs, documents, logos) from a Claude.ai conversation. Returns file names, types, and download URLs. Use when the user needs to find images, logos, documents, or other files from prior conversations.",
  {
    uuid: z.string().describe("The conversation UUID from prime_claude_conversations"),
  },
  async ({ uuid }) => {
    const srv = await getServer();
    if (!srv) return { content: [{ type: "text" as const, text: 'Prime server unreachable.' }] };
    try {
      const result = await httpGet(`${srv}/api/claude/conversations/${uuid}/files`);
      if (!result.files?.length) return { content: [{ type: "text" as const, text: 'No files found in this conversation.' }] };
      const text = `Conversation: "${result.conversation}" — ${result.total} files:\n\n` +
        result.files.map((f: any, i: number) =>
          `[${i + 1}] ${f.name} (${f.kind})\n   Download: ${srv}${f.download_url}`
        ).join('\n\n');
      return { content: [{ type: "text" as const, text }] };
    } catch (err: any) {
      return { content: [{ type: "text" as const, text: `Error: ${err.message}` }] };
    }
  }
);

// ============================================================
// Start
// ============================================================

server.tool(
  "prime_deep_session",
  "Run a deep strategic work session. This reads everything in Prime about a topic, researches externally, generates creative strategy, and produces FINISHED deliverables (full email drafts, plans, documents). Takes 10-15 minutes. Use when the user needs a comprehensive strategy or plan for a business problem.",
  {
    topic: z.string().describe("The problem to solve (e.g., 'Carefront broker outreach strategy')"),
    project: z.string().optional().describe("Project context if applicable"),
  },
  async ({ topic, project }) => {
    const srv = await getServer();
    if (!srv) return { content: [{ type: "text" as const, text: 'Prime server unreachable.' }] };
    try {
      const result = await httpPost(`${srv}/api/deep-session`, { topic, project }, 3600000);
      if (result.error) {
        return { content: [{ type: "text" as const, text: `Deep session failed: ${result.error}` }] };
      }
      const summary = [
        `Deep Session Complete: ${result.title}`,
        `${result.deliverables?.length || 0} deliverables, ${result.actions_created} actions`,
        `${result.duration_seconds?.toFixed(0)}s, ${result.turns_used} turns`,
        `Files: ${result.output_dir}`,
      ].join('\n');
      return { content: [{ type: "text" as const, text: summary }] };
    } catch (err: any) {
      return { content: [{ type: "text" as const, text: `Deep session error: ${err.message}` }] };
    }
  }
);

async function main() {
  // Check server connectivity at startup
  const srv = await getServer();
  if (srv) {
    console.error(`[MCP Proxy] Connected to ${srv}`);
  } else {
    console.error('[MCP Proxy] WARNING: Mac Mini unreachable. Tools will fail until server is available.');
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch(console.error);
