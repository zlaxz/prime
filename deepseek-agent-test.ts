import Database from 'better-sqlite3';
import { homedir } from 'os';
import { OpenAI } from 'openai';

// ============================================================
// DeepSeek Tool-Calling Agent — Goes to the shelf
//
// This agent uses DeepSeek's function calling to:
// 1. Search the knowledge base (find relevant items)
// 2. Read actual source material (Gmail threads via API)
// 3. Compile a wiki page from what it ACTUALLY READ
// ============================================================

const db = new Database(homedir() + '/.prime/prime.db');
const ds = new OpenAI({
  apiKey: process.env.DEEPSEEK_API_KEY,
  baseURL: 'https://api.deepseek.com',
});

// ── Tool Definitions (what DeepSeek can call) ──

const tools: OpenAI.Chat.Completions.ChatCompletionTool[] = [
  {
    type: 'function',
    function: {
      name: 'search_knowledge',
      description: 'Search the knowledge base for items matching a query. Returns titles, summaries, dates, and source_refs.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search query' },
          project: { type: 'string', description: 'Filter by project name (optional)' },
          limit: { type: 'number', description: 'Max results (default 10)' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_source_content',
      description: 'Retrieve content from a source (email thread, Claude conversation, document, cowork session). Supports modes: "full" returns full content (may be truncated for very large sources), "summary" returns a concise summary, "search" finds relevant passages matching a query within the source. Use summary first for large sources, then search for specific sections.',
      parameters: {
        type: 'object',
        properties: {
          source_ref: { type: 'string', description: 'The source_ref from a knowledge item (e.g., "thread:abc123", "claude-artifact:xyz")' },
          mode: { type: 'string', enum: ['full', 'summary', 'search'], description: 'Retrieval mode. Default: full. Use summary for large sources, search to find specific passages.' },
          search_query: { type: 'string', description: 'When mode=search, find passages matching this query within the source.' },
          offset: { type: 'number', description: 'Start from this character position (for paginating large sources)' },
          limit: { type: 'number', description: 'Max characters to return (default 8000)' },
        },
        required: ['source_ref'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_commitments',
      description: 'Get open commitments for a project or person.',
      parameters: {
        type: 'object',
        properties: {
          project: { type: 'string', description: 'Filter by project' },
          person: { type: 'string', description: 'Filter by person name' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_calendar',
      description: 'Get upcoming calendar events.',
      parameters: {
        type: 'object',
        properties: {
          days: { type: 'number', description: 'How many days ahead (default 7)' },
        },
      },
    },
  },
];

// ── Tool Executors (what happens when DeepSeek calls a tool) ──

async function executeTool(name: string, args: any): Promise<string> {
  switch (name) {
    case 'search_knowledge': {
      const limit = args.limit || 10;
      const projectFilter = args.project ? `AND project = '${args.project}'` : '';
      // Use FTS5 for search, join back to knowledge for full data
      try {
        const ftsResults = db.prepare(`
          SELECT k.title, substr(k.summary, 1, 300) as summary, k.source, k.source_date, k.source_ref, k.source_account
          FROM knowledge_fts fts
          JOIN knowledge k ON k.rowid = fts.rowid
          WHERE knowledge_fts MATCH ?
          ${projectFilter ? "AND k.project = '" + args.project + "'" : ''}
          ORDER BY fts.rank LIMIT ?
        `).all(args.query, limit) as any[];
        if (ftsResults.length > 0) return JSON.stringify(ftsResults);
      } catch {}
      // Fallback to LIKE
      const projectWhere = args.project ? `AND project = '${args.project}'` : '';
      const likeResults = db.prepare(`
        SELECT title, substr(summary, 1, 300) as summary, source, source_date, source_ref, source_account
        FROM knowledge
        WHERE (title LIKE ? OR summary LIKE ?) ${projectWhere}
        ORDER BY source_date DESC LIMIT ?
      `).all('%' + args.query + '%', '%' + args.query + '%', limit) as any[];
      return JSON.stringify(likeResults);
    }

    case 'get_source_content': {
      const ref = args.source_ref;
      const mode = args.mode || 'full';
      const offset = args.offset || 0;
      const limit = args.limit || 8000;

      // Get the full content first
      let fullContent = '';

      if (ref.startsWith('thread:')) {
        try {
          const { retrieveSourceContent } = await import('./src/source-retrieval.js');
          const item = db.prepare('SELECT * FROM knowledge WHERE source_ref = ? LIMIT 1').get(ref) as any;
          if (!item) return 'Source not found in knowledge base.';
          const result = await retrieveSourceContent(db, item);
          if (result) fullContent = result.content;
          else return 'Could not retrieve from API.';
        } catch (e: any) {
          return 'Retrieval error: ' + (e.message || '').slice(0, 200);
        }
      } else {
        // Non-Gmail: check raw_content first, then summary
        const item = db.prepare('SELECT title, summary, raw_content FROM knowledge WHERE source_ref = ?').get(ref) as any;
        if (!item) return 'Source not found.';
        fullContent = item.raw_content || item.summary || '';
      }

      if (!fullContent) return 'No content available for this source.';

      // Apply mode
      if (mode === 'summary') {
        // Return first 500 chars + last 500 chars as a quick summary
        if (fullContent.length <= 1500) return fullContent;
        return 'SOURCE SUMMARY (' + fullContent.length + ' total chars):\n\n' +
          'BEGINNING:\n' + fullContent.slice(0, 800) +
          '\n\n...[' + (fullContent.length - 1600) + ' chars omitted]...\n\n' +
          'END:\n' + fullContent.slice(-800);
      }

      if (mode === 'search' && args.search_query) {
        // Find passages containing the search query
        const query = args.search_query.toLowerCase();
        const passages: string[] = [];
        let searchIdx = 0;
        while (searchIdx < fullContent.length && passages.length < 5) {
          const found = fullContent.toLowerCase().indexOf(query, searchIdx);
          if (found === -1) break;
          // Extract 500 chars around the match
          const start = Math.max(0, found - 250);
          const end = Math.min(fullContent.length, found + query.length + 250);
          passages.push('...' + fullContent.slice(start, end) + '...');
          searchIdx = found + query.length;
        }
        if (passages.length === 0) return 'No passages matching "' + args.search_query + '" found in this source (' + fullContent.length + ' chars total).';
        return 'SEARCH RESULTS for "' + args.search_query + '" (' + passages.length + ' passages found in ' + fullContent.length + ' char source):\n\n' + passages.join('\n\n---\n\n');
      }

      // Full mode with offset/limit
      if (offset > 0 || fullContent.length > limit) {
        const chunk = fullContent.slice(offset, offset + limit);
        return 'CONTENT (chars ' + offset + '-' + (offset + chunk.length) + ' of ' + fullContent.length + ' total):\n\n' + chunk;
      }

      return fullContent.slice(0, limit);
    }

    case 'get_commitments': {
      const where: string[] = ["state NOT IN ('fulfilled', 'cancelled', 'archived')"];
      if (args.project) where.push(`project = '${args.project}'`);
      if (args.person) where.push(`(owner LIKE '%${args.person}%' OR assigned_to LIKE '%${args.person}%')`);
      const results = db.prepare(`SELECT text, owner, state, due_date, project FROM commitments WHERE ${where.join(' AND ')} LIMIT 20`).all();
      return JSON.stringify(results);
    }

    case 'get_calendar': {
      const days = args.days || 7;
      const results = db.prepare(`
        SELECT title, summary, source_date FROM knowledge
        WHERE source = 'calendar' AND source_date >= datetime('now') AND source_date <= datetime('now', '+${days} days')
        ORDER BY source_date ASC
      `).all();
      return JSON.stringify(results);
    }

    default:
      return 'Unknown tool: ' + name;
  }
}

// ── Agent Loop ──

async function runAgent(systemPrompt: string, maxTurns: number = 15): Promise<string> {
  const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
    { role: 'user', content: systemPrompt },
  ];

  for (let turn = 0; turn < maxTurns; turn++) {
    const response = await ds.chat.completions.create({
      model: 'deepseek-reasoner',
      messages,
      tools,
      temperature: 0.5,
      max_tokens: 16000,
    });

    const choice = response.choices[0];
    const msg = choice.message;
    messages.push(msg);

    // If no tool calls, the agent is done
    if (!msg.tool_calls || msg.tool_calls.length === 0) {
      console.log(`  Agent completed in ${turn + 1} turns`);
      return msg.content || '';
    }

    // Execute each tool call
    for (const tc of msg.tool_calls) {
      const args = JSON.parse(tc.function.arguments);
      console.log(`  [Turn ${turn + 1}] Tool: ${tc.function.name}(${JSON.stringify(args).slice(0, 100)})`);
      const result = await executeTool(tc.function.name, args);
      console.log(`    → ${result.length} chars returned`);
      messages.push({
        role: 'tool',
        tool_call_id: tc.id,
        content: result.slice(0, 12000), // Give agent full context
      });
    }
  }

  // If we hit max turns, return whatever the last message was
  const last = messages[messages.length - 1];
  return (last as any).content || 'Agent reached max turns without completing.';
}

// ── Main ──

async function main() {
  const now = new Date();
  const dayName = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'][now.getDay()];
  const dateStr = `${dayName}, ${now.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}`;

  console.log('=== DeepSeek Tool-Calling Agent: Carefront Wiki Page ===\n');
  console.log(`Date: ${dateStr}\n`);

  const prompt = `You are a project research analyst compiling a wiki page for Carefront Insurance.
TODAY IS: ${dateStr}

You have tools that give you access to the ACTUAL source material — real emails, meeting transcripts, Claude conversations, documents. Do NOT rely on search summaries. Go read the actual content.

INVESTIGATE THOROUGHLY:
1. Search for Carefront to find what's happening
2. For anything important, READ THE ACTUAL SOURCE (get_source_content) — the email thread, the transcript, the document
3. If something doesn't make sense, search again. Dig deeper. Be curious.
4. Check commitments — who owes what to whom
5. Check the calendar — what meetings are coming up
6. If you find a claim that seems important but you can't verify, say so explicitly

You are a PM who READS the actual emails, not a summarizer who reformats bullet points.

After your investigation, compile a wiki page:
# Carefront Insurance
Status, Current Situation (FROM WHAT YOU ACTUALLY READ), Key People, Timeline (day-of-week on ALL dates), Open Items, What Zach Should Know

Every claim should be based on something you actually retrieved and read.

IMPORTANT: Stay focused on CAREFRONT. If you discover cross-project connections, note them briefly but don't investigate other projects deeply. Your job is the Carefront wiki page.

When you have enough information (after reading 5-8 source documents), STOP investigating and WRITE THE WIKI PAGE. Don't use all your turns on research — save turns for producing the output.`;

  const t = Date.now();
  const result = await runAgent(prompt, 100);
  console.log(`\nTotal time: ${((Date.now() - t) / 1000).toFixed(1)}s\n`);
  console.log('=== WIKI PAGE OUTPUT ===\n');
  console.log(result);
}

main().then(() => process.exit(0)).catch(e => { console.error('FATAL:', e.message); process.exit(1); });
