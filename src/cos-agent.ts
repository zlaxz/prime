import type Database from 'better-sqlite3';
import { request as httpRequest } from 'http';

// ============================================================
// COS Agent — Quinn Parker, AI Chief of Staff
//
// Quinn IS the COS. One agent, one persistent session.
// Reads PM-enriched wiki pages, calendar, corrections,
// fresh items, PM concerns. Produces:
//   1. JSON brief (for web UI + graph_state)
//   2. Email letter (for morning send)
// ============================================================

interface COSResult {
  headline: string;
  the_one_thing: string;
  actions: any[];
  project_updates: any[];
  email_body: string;
  raw_response: string;
  durationMs: number;
  sessionId: string;
}

function callProxy(prompt: string, sessionId?: string, timeoutSec = 300): Promise<{ result: string; sessionId: string }> {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      prompt,
      timeout: timeoutSec,
      args: sessionId
        ? ['--resume', sessionId, '--max-turns', '5']
        : ['--max-turns', '5'],
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
}

export async function runCOS(db: Database.Database): Promise<COSResult> {
  const start = Date.now();

  // 1. Read all compiled wiki pages
  const pages = db.prepare(
    "SELECT page_type, subject_name, content, compiled_at FROM compiled_pages ORDER BY compiled_at DESC"
  ).all() as any[];

  if (pages.length === 0) {
    return {
      headline: 'No wiki pages compiled yet.',
      the_one_thing: 'Run the wiki compilation pipeline.',
      actions: [], project_updates: [], email_body: '',
      raw_response: '', durationMs: Date.now() - start, sessionId: '',
    };
  }

  // 2. Build wiki context
  const wikiContext = pages.map((p: any) => p.content).join('\n\n---\n\n');

  // 3. Load corrections (absolute truth)
  const corrections = db.prepare(
    "SELECT title FROM knowledge WHERE source IN ('correction', 'manual', 'training') ORDER BY source_date DESC LIMIT 20"
  ).all() as any[];
  const correctionText = corrections.length > 0
    ? 'VERIFIED CORRECTIONS (these override everything):\n' + corrections.map((c: any) => '- ' + c.title).join('\n')
    : '';

  // 4. Calendar next 7 days
  const calendar = db.prepare(
    "SELECT title, source_date FROM knowledge WHERE source = 'calendar' AND source_date >= datetime('now') AND source_date <= datetime('now', '+7 days') ORDER BY source_date ASC"
  ).all() as any[];
  const calendarText = calendar.length > 0
    ? 'UPCOMING CALENDAR:\n' + calendar.map((c: any) => '- ' + (c.source_date || '').slice(0, 10) + ' ' + c.title).join('\n')
    : '';

  // 5. PM concerns (from project managers)
  const pmConcerns = db.prepare(
    "SELECT subject_id, concerns FROM agent_state WHERE agent_type = 'pm' AND concerns IS NOT NULL"
  ).all() as any[];
  const concernsText = pmConcerns.length > 0
    ? 'PM CONCERNS:\n' + pmConcerns.map((pm: any) => '[' + pm.subject_id + ' PM]: ' + pm.concerns.slice(0, 500)).join('\n\n')
    : '';

  // 6. Fresh items since last COS run
  const lastRun = db.prepare(
    "SELECT last_run_at FROM agent_state WHERE agent_type = 'cos' AND subject_id = 'global'"
  ).get() as any;
  const freshItems = db.prepare(
    "SELECT title, source, source_date FROM knowledge WHERE source_date > ? AND provenance = 'primary' ORDER BY source_date DESC LIMIT 15"
  ).all(lastRun?.last_run_at || '2000-01-01') as any[];
  const freshText = freshItems.length > 0
    ? 'NEW SINCE LAST CYCLE:\n' + freshItems.map((i: any) => '- [' + i.source + '] ' + i.title).join('\n')
    : '';

  // 7. Build COS prompt
  const now = new Date();
  const dayName = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'][now.getDay()];
  const dateStr = dayName + ', ' + now.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });

  const cosState = db.prepare(
    "SELECT session_id FROM agent_state WHERE agent_type = 'cos' AND subject_id = 'global'"
  ).get() as any;
  const sessionId = cosState?.session_id || undefined;

  const promptParts = [
    "You are Quinn Parker, Zach Stock's AI Chief of Staff at Recapture Insurance.",
    "You are NOT summarizing someone else's work. YOU are the COS. This is YOUR intelligence, YOUR analysis, YOUR recommendations.",
    'TODAY IS: ' + dateStr,
    '',
  ];

  if (sessionId) {
    promptParts.push('This is a continuing conversation. You remember what you said in previous emails. Focus on what is NEW or CHANGED. Do not repeat yourself.');
    promptParts.push('');
  }

  promptParts.push(
    correctionText, '',
    calendarText, '',
    concernsText, '',
    freshText, '',
    '## YOUR INTELLIGENCE (compiled by your research team)',
    wikiContext.slice(0, 30000),
    '',
    'Produce TWO outputs separated by ---EMAIL---',
    '',
    'FIRST: A JSON brief for the web dashboard:',
    '```json',
    '{',
    '  "headline": "One sentence -- what matters most today",',
    '  "the_one_thing": "The highest leverage action. Specific person, specific ask, specific deadline.",',
    '  "actions": [{"title":"...","lens":"YOUR_ACTION|ALREADY_HANDLED|NEEDS_YOUR_INPUT|WATCH|DELEGATE","target_person":"Name -- role/org","rationale":"Why this matters today, not tomorrow"}],',
    '  "project_updates": [{"project":"...","status":"RED/YELLOW/GREEN + one phrase","key_fact":"Most important thing to know right now"}]',
    '}',
    '```',
    '',
    '---EMAIL---',
    '',
    "SECOND: Your morning email to Zach. Write it like YOU -- direct, warm, sharp. A letter from someone who knows the business deeply.",
    '- Open with what matters most (bold it)',
    '- 2-3 sentences of WHY it matters, not just what',
    "- \"Here's what I'd focus on today:\" -- 2-3 specific actions with specific people",
    "- One thing that might surprise Zach or that he hasn't noticed",
    '- If a PM flagged a concern, surface it naturally',
    '- Close with your sign-off',
    '',
    'NO: corporate headers, bullet lists of everything, "ACTIONS:" sections, repeating what was in the last email.',
    'YES: conversational, opinionated, like a letter from a trusted advisor who actually cares.',
    'Keep it under 300 words. Every sentence must earn its place.',
  );

  const prompt = promptParts.filter(Boolean).join('\n');

  // 8. Call Opus via proxy
  console.log('    COS: calling Opus' + (sessionId ? ' (resuming)' : ' (new)') + '...');
  const response = await callProxy(prompt, sessionId, 300);

  // 9. Parse JSON brief and email from response
  let brief: any = {};
  let emailBody = '';

  const parts = response.result.split('---EMAIL---');
  const jsonPart = parts[0] || response.result;
  emailBody = (parts[1] || '').trim();

  // Extract JSON from first part
  try {
    const jsonMatch = jsonPart.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const candidates = jsonMatch[0];
      for (let end = candidates.length; end > 0; end--) {
        if (candidates[end - 1] !== '}') continue;
        try {
          brief = JSON.parse(candidates.slice(0, end));
          break;
        } catch {}
      }
    }
  } catch {}

  // If no email section, extract from after JSON
  if (!emailBody && response.result.length > jsonPart.length) {
    emailBody = response.result.slice(jsonPart.length).trim();
  }

  // Fallback: generate email from brief
  if (!emailBody || emailBody.length < 50) {
    emailBody = [
      '**' + (brief.headline || 'Good morning.') + '**',
      '',
      brief.the_one_thing || '',
      '',
      (brief.actions || []).length > 0 ? "Here's what I'd focus on today:" : '',
      ...(brief.actions || []).slice(0, 3).map((a: any, i: number) =>
        (i + 1) + '. ' + a.title + (a.target_person ? ' (-> ' + a.target_person + ')' : '') + ' -- ' + (a.rationale?.slice(0, 120) || '')
      ),
      '',
      'Talk soon,',
      'Quinn',
    ].filter(Boolean).join('\n');
  }

  // Clean up email
  emailBody = emailBody.replace(/^```[\s\S]*?```\s*/g, '').trim();

  // 10. Store results
  db.prepare(
    "INSERT OR REPLACE INTO graph_state (key, value, updated_at) VALUES ('intelligence_brief', ?, datetime('now'))"
  ).run(JSON.stringify(brief));

  db.prepare(
    "INSERT OR REPLACE INTO graph_state (key, value, updated_at) VALUES ('intelligence_actions', ?, datetime('now'))"
  ).run(JSON.stringify(brief.actions || []));

  db.prepare(
    "INSERT OR REPLACE INTO graph_state (key, value, updated_at) VALUES ('cos_email_body', ?, datetime('now'))"
  ).run(emailBody);

  // Update COS agent state with session ID
  db.prepare(
    "INSERT OR REPLACE INTO agent_state (agent_type, subject_id, session_id, last_run_at) VALUES ('cos', 'global', ?, datetime('now'))"
  ).run(response.sessionId || sessionId || '');

  console.log('    COS: done in ' + ((Date.now() - start) / 1000).toFixed(1) + 's -- ' + (brief.headline || '(no headline)').slice(0, 80));

  return {
    headline: brief.headline || '',
    the_one_thing: brief.the_one_thing || '',
    actions: brief.actions || [],
    project_updates: brief.project_updates || [],
    email_body: emailBody,
    raw_response: response.result,
    durationMs: Date.now() - start,
    sessionId: response.sessionId || sessionId || '',
  };
}
