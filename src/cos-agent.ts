import type Database from 'better-sqlite3';
import { request as httpRequest } from 'http';

// ============================================================
// COS Agent — Opus-powered Chief of Staff
//
// Reads PM-enriched wiki pages as primary context.
// Uses --resume for persistent session across cycles.
// Same session for intelligence cycle + web UI chat.
// Produces: headline, actions, brief for Quinn email.
// ============================================================

interface COSResult {
  headline: string;
  the_one_thing: string;
  actions: any[];
  project_updates: any[];
  raw_response: string;
  durationMs: number;
  sessionId: string;
}

export async function runCOS(db: Database.Database): Promise<COSResult> {
  const start = Date.now();

  // 1. Read all compiled wiki pages
  const pages = db.prepare(
    "SELECT page_type, subject_name, content, compiled_at FROM compiled_pages ORDER BY compiled_at DESC"
  ).all() as any[];

  if (pages.length === 0) {
    return {
      headline: 'No wiki pages compiled yet. Run wiki agents first.',
      the_one_thing: 'Run the wiki compilation pipeline.',
      actions: [],
      project_updates: [],
      raw_response: '',
      durationMs: Date.now() - start,
      sessionId: '',
    };
  }

  // 2. Build wiki context (concise — just the pages)
  const wikiContext = pages.map((p: any) => p.content).join('\n\n---\n\n');

  // 3. Load corrections (absolute truth)
  const corrections = db.prepare(
    "SELECT title FROM knowledge WHERE source IN ('correction', 'manual', 'training') ORDER BY source_date DESC LIMIT 20"
  ).all() as any[];
  const correctionText = corrections.length > 0
    ? 'VERIFIED CORRECTIONS:\n' + corrections.map((c: any) => '- ' + c.title).join('\n')
    : '';

  // 4. Calendar next 7 days
  const calendar = db.prepare(
    "SELECT title, source_date FROM knowledge WHERE source = 'calendar' AND source_date >= datetime('now') AND source_date <= datetime('now', '+7 days') ORDER BY source_date ASC"
  ).all() as any[];
  const calendarText = calendar.length > 0
    ? 'UPCOMING CALENDAR:\n' + calendar.map((c: any) => '- ' + (c.source_date || '').slice(0, 10) + ' ' + c.title).join('\n')
    : '';

  // 5. Fresh items since last COS run
  const lastRun = db.prepare(
    "SELECT last_run_at FROM agent_state WHERE agent_type = 'cos' AND subject_id = 'global'"
  ).get() as any;
  const freshItems = db.prepare(
    "SELECT title, source, source_date FROM knowledge WHERE source_date > ? AND provenance = 'primary' ORDER BY source_date DESC LIMIT 10"
  ).all(lastRun?.last_run_at || '2000-01-01') as any[];
  const freshText = freshItems.length > 0
    ? 'NEW SINCE LAST CYCLE:\n' + freshItems.map((i: any) => '- [' + i.source + '] ' + i.title).join('\n')
    : '';

  // 6. Build COS prompt
  const now = new Date();
  const dayName = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'][now.getDay()];
  const dateStr = `${dayName}, ${now.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}`;

  const prompt = [
    'You are Prime, Zach Stock\'s AI Chief of Staff at Recapture Insurance.',
    'TODAY IS: ' + dateStr,
    '',
    correctionText,
    '',
    calendarText,
    '',
    freshText,
    '',
    '## COMPILED WIKI PAGES (from your research team)',
    'Below are wiki pages compiled by your research assistants and project managers.',
    'These are source-verified — they read actual emails and documents.',
    '',
    wikiContext.slice(0, 30000),  // Cap at 30K chars
    '',
    'Based on these wiki pages, produce a morning intelligence brief.',
    '',
    'Return ONLY this JSON:',
    '{',
    '  "headline": "One sentence — what matters today",',
    '  "the_one_thing": "Highest leverage action this week. Specific person, ask, deadline.",',
    '  "actions": [{"title":"...","lens":"YOUR_ACTION|ALREADY_HANDLED|NEEDS_YOUR_INPUT|WATCH|DELEGATE","target_person":"...","rationale":"..."}],',
    '  "project_updates": [{"project":"...","status":"...","key_fact":"..."}]',
    '}',
    '',
    'RULES: Be factual. Be grounded. No speculation. Maximum 3 actions. Use correct day-of-week for all dates.',
  ].filter(Boolean).join('\n');

  // 7. Get COS session for --resume
  const cosState = db.prepare(
    "SELECT session_id FROM agent_state WHERE agent_type = 'cos' AND subject_id = 'global'"
  ).get() as any;
  const sessionId = cosState?.session_id || undefined;

  // 8. Call Opus via proxy
  console.log('    COS: calling Opus' + (sessionId ? ' (resuming session)' : ' (new session)') + '...');
  const response: { result: string; sessionId: string } = await new Promise((resolve, reject) => {
    const body = JSON.stringify({
      prompt,
      timeout: 300,
      args: sessionId
        ? ['--resume', sessionId, '--max-turns', '10']
        : ['--max-turns', '10'],
    });
    const req = httpRequest('http://localhost:3211/claude', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      timeout: 330000,
    }, (res) => {
      let data = '';
      res.on('data', (d: Buffer) => { data += d.toString(); });
      res.on('end', () => {
        if (res.statusCode === 200) {
          try {
            const parsed = JSON.parse(data);
            resolve({ result: parsed.result || '', sessionId: parsed.session_id || '' });
          } catch { resolve({ result: data, sessionId: '' }); }
        } else {
          reject(new Error('Proxy: ' + res.statusCode));
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('COS timeout')); });
    req.write(body);
    req.end();
  });

  // 9. Parse JSON from response
  let brief: any = {};
  try {
    const jsonStart = response.result.indexOf('{');
    if (jsonStart >= 0) {
      for (let end = response.result.length; end > jsonStart; end--) {
        if (response.result[end - 1] !== '}') continue;
        try {
          brief = JSON.parse(response.result.slice(jsonStart, end));
          break;
        } catch {}
      }
    }
  } catch {}

  // 10. Store results
  db.prepare(
    "INSERT OR REPLACE INTO graph_state (key, value, updated_at) VALUES ('intelligence_brief', ?, datetime('now'))"
  ).run(JSON.stringify(brief));

  db.prepare(
    "INSERT OR REPLACE INTO graph_state (key, value, updated_at) VALUES ('intelligence_actions', ?, datetime('now'))"
  ).run(JSON.stringify(brief.actions || []));

  // Update COS agent state with session ID
  db.prepare(`
    INSERT OR REPLACE INTO agent_state (agent_type, subject_id, session_id, last_run_at)
    VALUES ('cos', 'global', ?, datetime('now'))
  `).run(response.sessionId || sessionId || '');

  console.log('    COS: done in ' + ((Date.now() - start) / 1000).toFixed(1) + 's — ' + (brief.headline || '(no headline)').slice(0, 80));

  return {
    headline: brief.headline || '',
    the_one_thing: brief.the_one_thing || '',
    actions: brief.actions || [],
    project_updates: brief.project_updates || [],
    raw_response: response.result,
    durationMs: Date.now() - start,
    sessionId: response.sessionId || sessionId || '',
  };
}
