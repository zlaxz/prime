import type Database from 'better-sqlite3';
import { request as httpRequest } from 'http';
import { v4 as uuid } from 'uuid';

// ============================================================
// Web Research Agent — Daily internet scan for Prime
//
// Runs once per day (20-hour gate). Uses Opus via proxy to
// search the web for articles relevant to Prime's domains:
// AI agents, MCP, insurance tech, competitors.
// Stores findings in the knowledge base for Quinn to pick up.
// ============================================================

interface Article {
  title: string;
  url: string;
  summary: string;
  relevance: string;
  topic: string;
}

function callProxy(prompt: string, timeoutSec = 180): Promise<string> {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      prompt,
      timeout: timeoutSec,
      args: ['--max-turns', '20'],
    });
    const req = httpRequest('http://localhost:3211/claude', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      timeout: (timeoutSec + 30) * 1000,
    }, (res) => {
      let data = '';
      res.on('data', (d: Buffer) => { data += d.toString(); });
      res.on('end', () => {
        if (res.statusCode === 200) {
          try {
            const parsed = JSON.parse(data);
            resolve(parsed.result || '');
          } catch { resolve(data); }
        } else {
          reject(new Error('Proxy: ' + res.statusCode));
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Research proxy timeout')); });
    req.write(body);
    req.end();
  });
}

export async function runDailyWebResearch(db: Database.Database): Promise<{ articles: number; skipped: boolean }> {
  // 1. Check if research already ran within last 20 hours
  const lastRunRow = db.prepare(
    "SELECT value FROM graph_state WHERE key = 'last_web_research'"
  ).get() as any;

  if (lastRunRow) {
    try {
      const lastData = JSON.parse(lastRunRow.value);
      const lastRunTime = new Date(lastData.timestamp).getTime();
      const hoursSince = (Date.now() - lastRunTime) / 3600000;
      if (hoursSince < 20) {
        console.log('[research] Skipping — last ran ' + hoursSince.toFixed(1) + 'h ago');
        return { articles: 0, skipped: true };
      }
    } catch (_e) {}
  }

  console.log('[research] Starting daily web research...');
  const start = Date.now();

  // 2. Build the research prompt
  const today = new Date().toISOString().slice(0, 10);
  const prompt = 'You are a research analyst. Search the web for articles published in the last 24-48 hours on these topics:\n\n'
    + '1. **AI agent architectures** — self-improving AI systems, skill/memory frameworks, agentic patterns\n'
    + '2. **MCP (Model Context Protocol)** — updates, new servers, Claude/Anthropic product news\n'
    + '3. **Insurance technology** — MGA operations, InsurTech innovation, digital distribution\n'
    + '4. **Enterprise AI assistants** — AI Chief of Staff systems, executive AI tools, productivity AI\n'
    + '5. **Competitors** — Saner.ai, Lindy, Granola, Mem0, OpenClaw, any new entrants\n\n'
    + 'For each relevant article you find, provide:\n'
    + '- **title**: The article title\n'
    + '- **url**: The full URL\n'
    + '- **summary**: One paragraph explaining what the article says and why it matters\n'
    + '- **relevance**: One sentence on how this relates to Prime (an AI Chief of Staff system with knowledge base, entity graph, wiki agents, and persistent memory)\n'
    + '- **topic**: One of: ai-agents, mcp, insurtech, enterprise-ai, competitors\n\n'
    + 'Search broadly across tech news, blogs, and announcement pages. Quality over quantity — only include articles that would genuinely inform someone building an AI COS system or running an insurance MGA.\n\n'
    + 'Limit to 3-5 most relevant articles. If a topic has nothing noteworthy in the last 48 hours, skip it.\n\n'
    + 'Output ONLY a JSON array (no markdown fences, no preamble):\n'
    + '[{"title":"...","url":"...","summary":"...","relevance":"...","topic":"..."}]\n\n'
    + 'Today is ' + today + '.';

  // 3. Call Opus via proxy
  let raw: string;
  try {
    raw = await callProxy(prompt, 180);
  } catch (err: any) {
    console.log('[research] Proxy call failed: ' + (err.message || '').slice(0, 80));
    return { articles: 0, skipped: false };
  }

  // 4. Parse the JSON array from response
  let articles: Article[] = [];
  try {
    // Try direct parse first
    articles = JSON.parse(raw);
  } catch {
    // Extract JSON array from surrounding text
    const match = raw.match(/\[[\s\S]*\]/);
    if (match) {
      try {
        articles = JSON.parse(match[0]);
      } catch {
        console.log('[research] Failed to parse JSON from response (' + raw.length + ' chars)');
        return { articles: 0, skipped: false };
      }
    } else {
      console.log('[research] No JSON array found in response (' + raw.length + ' chars)');
      return { articles: 0, skipped: false };
    }
  }

  if (!Array.isArray(articles) || articles.length === 0) {
    console.log('[research] No articles returned');
    return { articles: 0, skipped: false };
  }

  // 5. Store each article in knowledge table (dedup by URL)
  let stored = 0;
  for (const article of articles) {
    if (!article.title || !article.url) continue;

    // Dedup: skip if URL already exists
    const existing = db.prepare(
      "SELECT id FROM knowledge WHERE source_ref = ? LIMIT 1"
    ).get(article.url) as any;
    if (existing) {
      console.log('[research]   Skipping (dupe): ' + article.title.slice(0, 60));
      continue;
    }

    const id = uuid();
    const tags = JSON.stringify(['web-research', article.topic || 'general']);
    const summary = article.summary + (article.relevance ? '\n\nRelevance to Prime: ' + article.relevance : '');

    db.prepare(
      "INSERT INTO knowledge (id, title, summary, source, source_ref, source_date, importance, provenance, tags, created_at, updated_at) VALUES (?, ?, ?, 'web-research', ?, datetime('now'), 'normal', 'derived', ?, datetime('now'), datetime('now'))"
    ).run(id, article.title, summary, article.url, tags);

    stored++;
  }

  // 6. Update graph_state with timestamp and count
  db.prepare(
    "INSERT OR REPLACE INTO graph_state (key, value, updated_at) VALUES ('last_web_research', ?, datetime('now'))"
  ).run(JSON.stringify({
    timestamp: new Date().toISOString(),
    count: stored,
    total_found: articles.length,
  }));

  const durationSec = ((Date.now() - start) / 1000).toFixed(1);
  const titles = articles.slice(0, 5).map(a => a.title?.slice(0, 50)).join(', ');
  console.log('[research] Found ' + stored + ' articles in ' + durationSec + 's: ' + titles);

  return { articles: stored, skipped: false };
}
