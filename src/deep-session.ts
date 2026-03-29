/**
 * Deep Strategic Work Sessions
 *
 * Single claude -p call with all MCP tools. No pipeline. No phases.
 * Claude decides its own research order, challenges itself, produces finished work.
 *
 * Validated: 41 turns, 12.5 min, 11 deliverables, $0 on Max subscription.
 */

import Database from 'better-sqlite3';
import { spawn } from 'child_process';
import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { randomUUID } from 'crypto';
import { searchByEmbedding, getCommitments, getConfig } from './db.js';
import { generateEmbedding } from './embedding.js';
import { retrieveDeepContext } from './source-retrieval.js';
import { getEntityProfile } from './entities.js';
import { getCorrectionRules } from './intelligence-loop.js';
import { notify } from './notify.js';

// ── Types ──

interface DeepSessionResult {
  id: string;
  title: string;
  duration_seconds: number;
  turns_used: number;
  actions_created: number;
  output_dir: string;
  deliverables: Deliverable[];
}

interface Deliverable {
  title: string;
  type: 'strategy' | 'email' | 'document' | 'calendar' | 'analysis' | 'task';
  theme: string;
  content: string;
  filename: string;
  // For actionable items
  action?: {
    type: string;      // 'email', 'calendar', 'reminder'
    to?: string;
    subject?: string;
    body?: string;
  };
}

// ── Context Assembly ──

async function assembleContext(
  db: Database.Database,
  topic: string
): Promise<string> {
  const apiKey = getConfig(db, 'openai_api_key');
  const parts: string[] = [];

  // 1. Vector search for top 30 relevant items
  let searchResults: any[] = [];
  if (apiKey) {
    try {
      const queryEmb = await generateEmbedding(topic, apiKey);
      searchResults = searchByEmbedding(db, queryEmb, 30, 0.2);
    } catch (e: any) {
      console.log(`  [context] Vector search failed: ${e.message?.slice(0, 50)}`);
    }
  }

  if (searchResults.length > 0) {
    parts.push('=== RELEVANT KNOWLEDGE (top matches) ===');
    for (const item of searchResults.slice(0, 30)) {
      parts.push(`[${item.source}] ${item.title} (${item.source_date || 'undated'}, similarity: ${item.similarity?.toFixed(2)})`);
      parts.push(item.summary?.slice(0, 500) || '');
      parts.push('');
    }
  }

  // 2. Full source retrieval for top 5
  if (searchResults.length > 0) {
    try {
      const deepContext = await retrieveDeepContext(db, searchResults.slice(0, 5), 5);
      if (deepContext) {
        parts.push(deepContext);
      }
    } catch (e: any) {
      console.log(`  [context] Deep retrieval failed: ${e.message?.slice(0, 50)}`);
    }
  }

  // 3. Entity profiles for people mentioned in top results
  const entityNames = new Set<string>();
  for (const item of searchResults.slice(0, 10)) {
    try {
      const contacts = typeof item.contacts === 'string' ? JSON.parse(item.contacts) : item.contacts;
      if (Array.isArray(contacts)) {
        contacts.forEach((c: string) => entityNames.add(c));
      }
    } catch { /* skip */ }
  }

  if (entityNames.size > 0) {
    parts.push('=== KEY PEOPLE ===');
    for (const name of Array.from(entityNames).slice(0, 10)) {
      try {
        const profile = getEntityProfile(db, name);
        if (profile) {
          parts.push(`${profile.canonical_name} (${profile.type || 'contact'}) — ${profile.status}, ${profile.mention_count} mentions`);
          if (profile.projects?.length) parts.push(`  Projects: ${profile.projects.join(', ')}`);
          if (profile.commitments?.length) {
            parts.push(`  Open commitments: ${profile.commitments.map((c: any) => c.text).join('; ')}`);
          }
        }
      } catch { /* skip */ }
    }
    parts.push('');
  }

  // 4. Active commitments
  const commitments = getCommitments(db, { state: 'active' });
  const overdueCommitments = getCommitments(db, { overdue: true });
  if (commitments.length > 0 || overdueCommitments.length > 0) {
    parts.push('=== ACTIVE COMMITMENTS ===');
    for (const c of [...overdueCommitments, ...commitments].slice(0, 15)) {
      const due = c.due_date ? ` (due: ${c.due_date})` : '';
      const overdue = c.state === 'overdue' ? ' [OVERDUE]' : '';
      parts.push(`- ${c.text}${due}${overdue} — ${c.project || 'no project'}`);
    }
    parts.push('');
  }

  // 5. Correction rules
  const corrections = getCorrectionRules(db);
  if (corrections) {
    parts.push(corrections);
    parts.push('');
  }

  // Cap at ~50K tokens (~200K chars)
  let context = parts.join('\n');
  if (context.length > 200000) {
    context = context.slice(0, 200000) + '\n\n[Context truncated at 200K chars]';
  }

  console.log(`  [context] Assembled: ${context.length} chars, ${searchResults.length} search results, ${entityNames.size} entities, ${commitments.length + overdueCommitments.length} commitments`);
  return context;
}

// ── Prompt Construction ──

function buildPrompt(topic: string, context: string): string {
  return `You are Prime — an AI strategic partner and chief of staff for Zach Stock, founder of Recapture Insurance and Carefront MGA.

YOUR ROLE: You are a strategist, creative thinker, and executor rolled into one. You don't analyze problems — you SOLVE them. You produce FINISHED work, not recommendations for work.

THE PROBLEM: ${topic}

YOUR JOB:
1. Read the context below — it contains everything Prime knows about this topic
2. Use prime_search to find additional relevant information in the knowledge base
3. Use prime_retrieve to read the FULL content of important items (summaries aren't enough)
4. Use WebSearch to research external information (competitors, methodologies, market data)
5. Generate creative strategy with multi-order thinking
6. RED TEAM YOUR OWN PLAN — challenge every assumption, identify what could go wrong
7. Fill capability gaps INLINE — if you need copywriting, BECOME a copywriter and draft the copy NOW
8. Produce FINISHED deliverables: full email drafts (not templates), complete plans (not outlines), specific actions (not suggestions)
9. At the end, decompose your strategy into 10-15 atomic executable tasks, each with:
   - Specific who/what/when (not vague "do outreach")
   - Full content where applicable (the actual email text, the actual document)
   - Budget estimate if it costs money
   - Theme group (e.g., "Email Outreach", "Direct Mail", "Digital Presence")

FORMAT YOUR FINAL OUTPUT as a structured summary followed by the task list. Use markdown. Be thorough — 200+ lines is fine.

At the very end, output a JSON block wrapped in \`\`\`json fences with this structure:
{
  "title": "Session title (max 80 chars)",
  "summary": "3-line summary of what you found, recommend, and what's ready",
  "themes": ["Theme 1", "Theme 2", "Theme 3"],
  "deliverables": [
    {
      "title": "Deliverable name",
      "type": "strategy|email|document|calendar|analysis|task",
      "theme": "Which theme this belongs to",
      "content": "Full content of the deliverable (complete email text, full document, etc.)",
      "action": {"type": "email", "to": "person@example.com", "subject": "Subject", "body": "Full body"}
    }
  ]
}

Include ALL deliverables in the JSON — every email draft, every document, every plan section, every task.

=== PRIME KNOWLEDGE BASE CONTEXT ===

${context}

=== END CONTEXT ===

Now solve this problem. Take as long as you need. Use all available tools. Produce finished work.`;
}

// ── Claude -p Execution ──

async function runClaudeP(
  prompt: string,
  maxTurns: number = 200,     // Let Claude think as long as it needs
  timeoutMs: number = 3600000 // 60 minutes
): Promise<{ output: string; turns: number; duration: number }> {
  const start = Date.now();

  return new Promise((resolve, reject) => {
    const proc = spawn('claude', [
      '-p', '-',
      '--output-format', 'json',
      '--max-turns', String(maxTurns),
    ], {
      timeout: timeoutMs,
      env: { ...process.env, ANTHROPIC_API_KEY: '' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let out = '';
    let err = '';
    proc.stdout.on('data', (d: Buffer) => { out += d.toString(); });
    proc.stderr.on('data', (d: Buffer) => { err += d.toString(); });

    proc.on('close', (code) => {
      const duration = (Date.now() - start) / 1000;
      if (code === 0) {
        try {
          const envelope = JSON.parse(out);
          resolve({
            output: envelope.result || out,
            turns: envelope.num_turns || 0,
            duration,
          });
        } catch {
          // If JSON parse fails, return raw output
          resolve({ output: out, turns: 0, duration });
        }
      } else {
        reject(new Error(`claude -p exited with ${code} after ${duration.toFixed(0)}s: ${err.slice(0, 300)}`));
      }
    });

    proc.on('error', reject);
    proc.stdin.write(prompt);
    proc.stdin.end();
  });
}

// ── Output Parsing ──

function parseDeliverables(rawOutput: string): { title: string; summary: string; deliverables: Deliverable[] } {
  // Try to find JSON block at the end of the output
  const jsonMatch = rawOutput.match(/```json\s*\n([\s\S]*?)\n```/);

  let parsed: any = null;
  if (jsonMatch) {
    try {
      parsed = JSON.parse(jsonMatch[1]);
    } catch {
      console.log('  [parse] JSON block found but failed to parse');
    }
  }

  if (!parsed) {
    // Fallback: treat entire output as a single document
    return {
      title: 'Deep Session Output',
      summary: rawOutput.slice(0, 300),
      deliverables: [{
        title: 'Full Output',
        type: 'document',
        theme: 'Strategy',
        content: rawOutput,
        filename: 'full-output.md',
      }],
    };
  }

  // Map parsed deliverables to our format
  const deliverables: Deliverable[] = (parsed.deliverables || []).map((d: any, i: number) => {
    const slug = (d.title || `deliverable-${i + 1}`)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 50);

    return {
      title: d.title || `Deliverable ${i + 1}`,
      type: d.type || 'document',
      theme: d.theme || 'General',
      content: d.content || '',
      filename: `${slug}.md`,
      action: d.action || undefined,
    };
  });

  return {
    title: parsed.title || 'Deep Session',
    summary: parsed.summary || '',
    deliverables,
  };
}

// ── File Output ──

function writeDeliverableFiles(deliverables: Deliverable[], outputDir: string): void {
  mkdirSync(outputDir, { recursive: true });

  for (const d of deliverables) {
    const filePath = join(outputDir, d.filename);
    const header = `# ${d.title}\n\n*Theme: ${d.theme} | Type: ${d.type}*\n\n---\n\n`;
    writeFileSync(filePath, header + d.content);
  }

  // Write index file
  const index = deliverables
    .map(d => `- [${d.title}](${d.filename}) — ${d.theme} (${d.type})`)
    .join('\n');
  writeFileSync(join(outputDir, 'README.md'), `# Deep Session Deliverables\n\n${index}\n`);
}

// ── Main Entry Point ──

export async function runDeepSession(
  db: Database.Database,
  topic: string,
  triggerSource: string = 'manual',
  project?: string,
): Promise<DeepSessionResult> {
  const sessionId = randomUUID();
  const startTime = Date.now();

  console.log(`\n=== DEEP SESSION: ${topic} ===`);
  console.log(`  ID: ${sessionId}`);
  console.log(`  Trigger: ${triggerSource}`);

  // Create DB record
  db.prepare(`
    INSERT INTO deep_sessions (id, title, project, trigger_source, status)
    VALUES (?, ?, ?, ?, 'running')
  `).run(sessionId, topic.slice(0, 200), project || null, triggerSource);

  try {
    // Step 1: Assemble context
    console.log('\n  Assembling context...');
    const context = await assembleContext(db, topic);

    db.prepare(`UPDATE deep_sessions SET context_assembled = ? WHERE id = ?`)
      .run(context.slice(0, 500000), sessionId);

    // Step 2: Build prompt and run claude -p
    console.log('  Running claude -p (this may take 10-15 minutes)...');
    const prompt = buildPrompt(topic, context);
    const { output, turns, duration } = await runClaudeP(prompt);

    console.log(`  Claude finished: ${turns} turns, ${duration.toFixed(0)}s`);

    db.prepare(`UPDATE deep_sessions SET claude_output = ?, turns_used = ? WHERE id = ?`)
      .run(output.slice(0, 1000000), turns, sessionId);

    // Step 3: Parse deliverables
    console.log('  Parsing deliverables...');
    const { title, summary, deliverables } = parseDeliverables(output);

    // Step 4: Write files
    const dateSlug = new Date().toISOString().split('T')[0];
    const topicSlug = topic.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40);
    const outputDir = join(homedir(), '.prime', 'deep-sessions', `${dateSlug}-${topicSlug}`);

    writeDeliverableFiles(deliverables, outputDir);
    console.log(`  Wrote ${deliverables.length} files to ${outputDir}`);

    // Step 5: Create staged actions for actionable deliverables
    let actionsCreated = 0;
    const insertAction = db.prepare(`
      INSERT INTO staged_actions (type, summary, payload, reasoning, project, source_task, deep_session_id, sequence_order, theme, expires_at)
      VALUES (?, ?, ?, ?, ?, 'deep-session', ?, ?, ?, datetime('now', '+7 days'))
    `);

    for (let i = 0; i < deliverables.length; i++) {
      const d = deliverables[i];
      if (d.action) {
        insertAction.run(
          d.action.type || 'task',
          d.title.slice(0, 200),
          JSON.stringify(d.action),
          `From deep session: ${title}`,
          project || null,
          sessionId,
          i + 1,
          d.theme,
        );
        actionsCreated++;
      }
    }

    console.log(`  Created ${actionsCreated} staged actions`);

    // Step 6: Update session record
    const totalDuration = (Date.now() - startTime) / 1000;
    db.prepare(`
      UPDATE deep_sessions
      SET status = 'completed', title = ?, deliverables = ?, output_dir = ?,
          duration_seconds = ?, actions_created = ?, completed_at = datetime('now')
      WHERE id = ?
    `).run(
      title.slice(0, 200),
      JSON.stringify({ title, summary, deliverables: deliverables.map(d => ({ ...d, content: d.content.slice(0, 500) })) }),
      outputDir,
      totalDuration,
      actionsCreated,
      sessionId,
    );

    // Step 7: Notify
    await notify(db, {
      title: `Deep Session Complete: ${title}`,
      body: `${summary}\n\n${deliverables.length} deliverables, ${actionsCreated} actions. ${totalDuration.toFixed(0)}s.`,
      urgency: 'high',
      project,
    });

    console.log(`\n  DONE: ${title}`);
    console.log(`  ${deliverables.length} deliverables, ${actionsCreated} actions`);
    console.log(`  ${totalDuration.toFixed(0)}s total`);
    console.log(`  Files: ${outputDir}`);

    return {
      id: sessionId,
      title,
      duration_seconds: totalDuration,
      turns_used: turns,
      actions_created: actionsCreated,
      output_dir: outputDir,
      deliverables,
    };

  } catch (error: any) {
    const totalDuration = (Date.now() - startTime) / 1000;
    db.prepare(`
      UPDATE deep_sessions SET status = 'failed', duration_seconds = ?, completed_at = datetime('now')
      WHERE id = ?
    `).run(totalDuration, sessionId);

    console.error(`  FAILED after ${totalDuration.toFixed(0)}s: ${error.message}`);
    throw error;
  }
}
