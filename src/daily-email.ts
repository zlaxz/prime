import type Database from 'better-sqlite3';
import { request as httpRequest } from 'http';
import { sendEmail } from './connectors/gmail.js';

// ============================================================
// Quinn Parker's Daily Intelligence Email
//
// Quinn WRITES the email — a letter from your COS, not a data dump.
// Uses persistent session via --resume so Quinn remembers what
// she already told you and can avoid repeating herself.
// ============================================================

/**
 * Call Opus via the localhost proxy (same pattern as COS/PM agents).
 * Returns { result, sessionId }.
 */
function callProxy(prompt: string, sessionId?: string, timeoutSec = 120): Promise<{ result: string; sessionId: string }> {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      prompt,
      timeout: timeoutSec,
      args: sessionId
        ? ['--resume', sessionId, '--max-turns', '3']
        : ['--max-turns', '3'],
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
    req.on('timeout', () => { req.destroy(); reject(new Error('Quinn proxy timeout')); });
    req.write(body);
    req.end();
  });
}

export async function sendDailyIntelligenceEmail(db: Database.Database): Promise<boolean> {
  try {
    const briefRaw = (db.prepare("SELECT value FROM graph_state WHERE key = 'intelligence_brief'").get() as any)?.value;
    if (!briefRaw) { console.log('[quinn] No intelligence brief to send'); return false; }
    const brief = JSON.parse(briefRaw);

    const actionsRaw = (db.prepare("SELECT value FROM graph_state WHERE key = 'intelligence_actions'").get() as any)?.value;
    const actions = actionsRaw ? JSON.parse(actionsRaw) : [];

    // Load Quinn's persistent session from agent_state
    const quinnState = db.prepare(
      "SELECT session_id FROM agent_state WHERE agent_type = 'quinn-email' AND subject_id = 'global'"
    ).get() as any;
    const sessionId = quinnState?.session_id || undefined;

    const now = new Date();
    const dayName = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'][now.getDay()];
    const dateStr = `${dayName}, ${now.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}`;

    // Build the prompt — Quinn has persistent memory of prior emails via --resume
    const quinnPrompt = `You are Quinn Parker, AI Chief of Staff at Recapture Insurance. Write a morning intelligence email to Zach Stock (your boss, the CEO).

TODAY IS: ${dateStr}

${sessionId ? 'You have sent previous emails in this conversation. DO NOT repeat what you already covered. Focus on what is NEW or has CHANGED since last time. If something was already communicated, skip it or reference it briefly ("As I mentioned...").' : 'This is your first email. Set the tone — direct, warm, sharp.'}

Write like a real COS — conversational, direct, no corporate-speak. Not a data dump. A LETTER.

Structure:
- Open with the single most important thing (bold it)
- 2-3 sentences of context on why it matters
- "Here's what I'd focus on today:" — 2-3 specific actions (not 5, just what matters TODAY)
- If there's a draft email or talking points, include the most important one
- One thing that surprised you or Zach might not have noticed
- Close with "Reply to this email if you want me to adjust anything."

DO NOT: list every hypothesis, use headers like "ACTIONS" "HYPOTHESES", include more than 3 items, use corporate language.

Tone: Direct, warm, occasionally witty. Like a sharp EA who's been with the company 2 years.

Raw intelligence:

HEADLINE: ${brief.headline || 'No headline'}
THE ONE THING: ${brief.the_one_thing || ''}
ACTIONS: ${JSON.stringify(actions.slice(0, 3), null, 2)}
TOP HYPOTHESES: ${JSON.stringify((brief.hypotheses || []).slice(0, 3).map((h: any) => ({ claim: h.claim, confidence: h.confidence })), null, 2)}
THEORIES OF MIND: ${JSON.stringify((brief.theories_of_mind || []).slice(0, 2).map((t: any) => ({ entity: t.entity, hypothesis: t.behavior_hypothesis })), null, 2)}
CONTRADICTIONS: ${JSON.stringify((brief.contradictions || []).slice(0, 2), null, 2)}

Write ONLY the email body text. No subject line. No HTML tags.`;

    let quinnLetter: string;
    let newSessionId = sessionId || '';
    try {
      const response = await callProxy(quinnPrompt, sessionId, 120);
      quinnLetter = response.result;
      newSessionId = response.sessionId || sessionId || '';

      // Validate response has real content
      const cleaned = (quinnLetter || '').replace(/\s+/g, ' ').trim();
      if (cleaned.length < 50) throw new Error(`Response too short: ${cleaned.length} chars`);
    } catch (callErr: any) {
      console.log(`[quinn] Proxy call failed (${callErr.message?.slice(0, 60)}), using fallback`);
      // Fallback: write the letter directly from the data (no LLM needed)
      const topAction = actions[0];
      quinnLetter = [
        `**${brief.headline || 'Good morning.'}**`,
        '',
        brief.the_one_thing || '',
        '',
        topAction ? `Here's what I'd focus on today:` : '',
        ...(actions.slice(0, 3).map((a: any, i: number) =>
          `${i + 1}. ${a.title}${a.target_person ? ` (-> ${a.target_person})` : ''} -- ${a.rationale?.slice(0, 100) || ''}`
        )),
        '',
        brief.theories_of_mind?.[0] ? `One thing to watch: ${brief.theories_of_mind[0].entity} -- ${brief.theories_of_mind[0].behavior_hypothesis?.slice(0, 150)}` : '',
        '',
        'Reply to this email if you want me to adjust anything.',
      ].filter(Boolean).join('\n');
    }

    // Persist Quinn's session ID for next run
    db.prepare(`
      INSERT OR REPLACE INTO agent_state (agent_type, subject_id, session_id, last_run_at)
      VALUES ('quinn-email', 'global', ?, datetime('now'))
    `).run(newSessionId);

    // Wrap in clean HTML
    const esc = (s: string) => (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br>');
    const date = new Date().toLocaleDateString('en-US', { timeZone: 'America/Denver', weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
    const kbCount = (db.prepare('SELECT COUNT(*) as c FROM knowledge').get() as any)?.c || '?';

    const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"></head>
<body style="margin:0;padding:0;background:#0a0e12;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
<div style="max-width:600px;margin:0 auto;padding:32px 24px;">
  <div style="font-size:15px;color:#cbd5e1;line-height:1.7;">${esc(quinnLetter)}</div>
  <div style="margin-top:32px;padding-top:16px;border-top:1px solid #1e293b;">
    <div style="font-size:13px;font-weight:500;color:#94a3b8;">Quinn Parker</div>
    <div style="font-size:11px;color:#475569;">AI Chief of Staff, Recapture Insurance</div>
    <div style="font-size:10px;color:#334155;margin-top:8px;">${date} | ${kbCount} items tracked | Reply to update Prime</div>
  </div>
</div></body></html>`;

    const rawSubject = brief.headline?.slice(0, 80) || 'Morning Brief';
    const subject = rawSubject.replace(/\u2014/g, '-').replace(/[^\x20-\x7E]/g, '');

    const result = await sendEmail(db, { to: 'zach.stock@recaptureinsurance.com', subject, body: html, html: true });

    if (result.success) {
      console.log(`[quinn] Daily email sent: "${subject.slice(0, 60)}" (session: ${newSessionId ? 'resumed' : 'new'})`);
      return true;
    } else {
      console.log(`[quinn] Email failed: ${result.error}`);
      return false;
    }
  } catch (err: any) {
    console.log(`[quinn] Email error: ${err.message}`);
    return false;
  }
}
