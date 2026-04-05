import { request as httpRequest } from 'http';

// ============================================================
// Opus Agent Test — Same prompt as DeepSeek test but via proxy
// Uses claude -p with MCP tools through the proxy at localhost:3211
// ============================================================

async function main() {
  const now = new Date();
  const dayName = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'][now.getDay()];
  const dateStr = `${dayName}, ${now.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}`;

  console.log('=== Claude Opus Agent: Carefront Wiki Page ===\n');
  console.log(`Date: ${dateStr}\n`);

  // Same prompt as the DeepSeek test
  const prompt = `You are a project research analyst compiling a wiki page for Carefront Insurance.
TODAY IS: ${dateStr}

You have tools. USE THEM to investigate:
- Use prime_search to find relevant knowledge items
- Use prime_retrieve to READ THE ACTUAL source material (emails, documents, conversations)
- Use prime_get_commitments for open commitments
- Use prime_entity for key people profiles

INVESTIGATE THOROUGHLY:
1. Search for Carefront to find what's happening
2. For anything important, READ THE ACTUAL SOURCE (prime_retrieve) — the email thread, the transcript, the document
3. If something doesn't make sense, search again. Dig deeper. Be curious.
4. Check commitments — who owes what to whom
5. If you find a claim that seems important but you can't verify, say so explicitly

You are a PM who READS the actual emails, not a summarizer who reformats bullet points.

After your investigation, compile a wiki page:
# Carefront Insurance
Status, Current Situation (FROM WHAT YOU ACTUALLY READ), Key People, Timeline (day-of-week on ALL dates), Open Items, What Zach Should Know

Every claim should be based on something you actually retrieved and read.

IMPORTANT: Stay focused on CAREFRONT. When you have enough information, STOP investigating and WRITE THE WIKI PAGE.`;

  console.log('Calling Opus via proxy with MCP tools (max 25 turns)...\n');

  const t = Date.now();
  const result: string = await new Promise((resolve, reject) => {
    const body = JSON.stringify({
      prompt,
      timeout: 600,
      args: ['--max-turns', '25'],
    });
    const req = httpRequest('http://localhost:3211/claude', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      timeout: 660000,
    }, (res) => {
      let data = '';
      res.on('data', (d: Buffer) => { data += d.toString(); });
      res.on('end', () => {
        if (res.statusCode === 200) {
          try { resolve(JSON.parse(data).result || data); } catch { resolve(data); }
        } else {
          reject(new Error('Proxy: ' + res.statusCode + ' ' + data.slice(0, 200)));
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.write(body);
    req.end();
  });

  console.log(`Total time: ${((Date.now() - t) / 1000).toFixed(1)}s\n`);
  console.log('=== OPUS WIKI PAGE OUTPUT ===\n');
  console.log(result);
}

main().then(() => process.exit(0)).catch(e => { console.error('FATAL:', e.message); process.exit(1); });
