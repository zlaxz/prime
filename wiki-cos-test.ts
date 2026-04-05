import Database from 'better-sqlite3';
import { homedir } from 'os';
import { request as httpRequest } from 'http';

async function main() {
  const db = new Database(homedir() + '/.prime/prime.db');

  const items = (db.prepare(
    `SELECT title, substr(summary,1,300) as summary, source, source_date
     FROM knowledge WHERE project = 'Carefront'
     AND source_date >= datetime('now', '-14 days')
     ORDER BY source_date DESC LIMIT 15`
  ).all() as any[]);

  const corrections = (db.prepare(
    `SELECT title FROM knowledge WHERE source IN ('correction','manual')
     AND summary LIKE '%Carefront%' ORDER BY source_date DESC LIMIT 5`
  ).all() as any[]);

  const now = new Date();
  const dayName = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'][now.getDay()];
  const dateStr = `${dayName}, ${now.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}`;

  const context = `TODAY IS: ${dateStr}\n\n` +
    (corrections.length > 0 ? 'CORRECTIONS:\n' + corrections.map((c: any) => '- ' + c.title).join('\n') + '\n\n' : '') +
    'ITEMS:\n' + items.map((i: any) => `[${(i.source_date || '').slice(0,10)} ${i.source}] ${i.title}\n  ${i.summary}`).join('\n');

  // STEP 1: DeepSeek compiles wiki page
  console.log('=== STEP 1: DeepSeek compiles Carefront wiki page ===');
  const { OpenAI } = await import('openai');
  const ds = new OpenAI({ apiKey: process.env.DEEPSEEK_API_KEY, baseURL: 'https://api.deepseek.com' });

  const t1 = Date.now();
  const r1 = await ds.chat.completions.create({
    model: 'deepseek-chat',
    messages: [{ role: 'user', content: `Compile an authoritative wiki page for Carefront Insurance. Include Status, Situation, Key People, Timeline (day-of-week), Open Items, What Zach Should Know. ONLY facts. No speculation.\n\n${context}` }],
    temperature: 0.1,
    max_tokens: 2500,
  });
  const wikiPage = r1.choices[0].message.content || '';
  console.log(`Wiki page compiled in ${((Date.now() - t1) / 1000).toFixed(1)}s\n`);
  console.log(wikiPage);
  console.log('\n' + '='.repeat(60) + '\n');

  // STEP 2: Feed wiki page to COS (Opus via proxy)
  console.log('=== STEP 2: COS reads wiki page → produces brief ===');
  const cosPrompt = `You are Prime, Zach Stock's AI Chief of Staff.
TODAY IS: ${dateStr}

Below is the compiled wiki page for Carefront Insurance, prepared by a project analyst.

${wikiPage}

Based on this, produce a brief for Zach:
1. Headline (one sentence)
2. The one thing (highest leverage action this week)
3. 2-3 actions tagged YOUR_ACTION / ALREADY_HANDLED / NEEDS_YOUR_INPUT / WATCH / DELEGATE

Be factual. Be grounded. No speculation.`;

  const t2 = Date.now();
  const cosResult: string = await new Promise((resolve, reject) => {
    const body = JSON.stringify({ prompt: cosPrompt, timeout: 120, args: [] });
    const req = httpRequest('http://localhost:3211/claude', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      timeout: 130000,
    }, (res) => {
      let data = '';
      res.on('data', (d: Buffer) => { data += d.toString(); });
      res.on('end', () => {
        if (res.statusCode === 200) {
          try { resolve(JSON.parse(data).result || data); } catch { resolve(data); }
        } else reject(new Error('Proxy: ' + res.statusCode));
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.write(body);
    req.end();
  });
  console.log(`COS brief in ${((Date.now() - t2) / 1000).toFixed(1)}s\n`);
  console.log(cosResult);

  process.exit(0);
}

main().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
