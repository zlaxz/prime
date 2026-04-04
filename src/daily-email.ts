import type Database from 'better-sqlite3';
import { sendEmail } from './connectors/gmail.js';
import { callClaude } from './dream.js';

// ============================================================
// Quinn Parker's Daily Intelligence Email
//
// Quinn WRITES the email — a letter from your COS, not a data dump.
// Uses callClaude to transform raw intelligence into human communication.
// ============================================================

export async function sendDailyIntelligenceEmail(db: Database.Database): Promise<boolean> {
  try {
    const briefRaw = (db.prepare("SELECT value FROM graph_state WHERE key = 'intelligence_brief'").get() as any)?.value;
    if (!briefRaw) { console.log('[quinn] No intelligence brief to send'); return false; }
    const brief = JSON.parse(briefRaw);

    const actionsRaw = (db.prepare("SELECT value FROM graph_state WHERE key = 'intelligence_actions'").get() as any)?.value;
    const actions = actionsRaw ? JSON.parse(actionsRaw) : [];

    // Have Quinn WRITE the email as a letter
    const quinnPrompt = `You are Quinn Parker, AI Chief of Staff at Recapture Insurance. Write a morning intelligence email to Zach Stock (your boss, the CEO).

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
    try {
      quinnLetter = await callClaude(quinnPrompt, 60000);
      // If callClaude returned empty, use fallback
      if (!quinnLetter || quinnLetter.trim().length < 50) throw new Error('Empty response');
    } catch {
      // Fallback: write the letter directly from the data (no LLM needed)
      const topAction = actions[0];
      quinnLetter = [
        `**${brief.headline || 'Good morning.'}**`,
        '',
        brief.the_one_thing || '',
        '',
        topAction ? `Here's what I'd focus on today:` : '',
        ...(actions.slice(0, 3).map((a: any, i: number) =>
          `${i + 1}. ${a.title}${a.target_person ? ` (→ ${a.target_person})` : ''} — ${a.rationale?.slice(0, 100) || ''}`
        )),
        '',
        brief.theories_of_mind?.[0] ? `One thing to watch: ${brief.theories_of_mind[0].entity} — ${brief.theories_of_mind[0].behavior_hypothesis?.slice(0, 150)}` : '',
        '',
        'Reply to this email if you want me to adjust anything.',
      ].filter(Boolean).join('\n');
    }

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
    const subject = rawSubject.replace(/—/g, '-').replace(/[^\x20-\x7E]/g, '');

    const result = await sendEmail(db, { to: 'zach.stock@recaptureinsurance.com', subject, body: html, html: true });

    if (result.success) {
      console.log(`[quinn] Daily email sent: "${subject.slice(0, 60)}"`);
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
