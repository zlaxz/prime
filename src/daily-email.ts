import type Database from 'better-sqlite3';
import { sendEmail } from './connectors/gmail.js';

// ============================================================
// Quinn's Daily Email — sends the COS email
//
// The COS agent (Quinn) produces the email content.
// This module just wraps it in HTML and sends it.
// No separate LLM call. Quinn IS the COS.
// ============================================================

export async function sendDailyIntelligenceEmail(db: Database.Database): Promise<boolean> {
  try {
    // Get Quinn's email from the COS agent output
    const emailBody = (db.prepare(
      "SELECT value FROM graph_state WHERE key = 'cos_email_body'"
    ).get() as any)?.value;

    const briefRaw = (db.prepare(
      "SELECT value FROM graph_state WHERE key = 'intelligence_brief'"
    ).get() as any)?.value;
    const brief = briefRaw ? JSON.parse(briefRaw) : {};

    if (!emailBody || emailBody.length < 30) {
      console.log('[quinn] No COS email body to send');
      return false;
    }

    // Wrap in clean HTML
    const esc = (s: string) => (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br>').replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
    const date = new Date().toLocaleDateString('en-US', { timeZone: 'America/Denver', weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
    const kbCount = (db.prepare('SELECT COUNT(*) as c FROM knowledge').get() as any)?.c || '?';

    const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"></head>
<body style="margin:0;padding:0;background:#0a0e12;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
<div style="max-width:600px;margin:0 auto;padding:32px 24px;">
  <div style="font-size:15px;color:#cbd5e1;line-height:1.7;">${esc(emailBody)}</div>
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
      console.log('[quinn] Email sent: "' + subject.slice(0, 60) + '"');
      return true;
    } else {
      console.log('[quinn] Email failed: ' + result.error);
      return false;
    }
  } catch (err: any) {
    console.log('[quinn] Email error: ' + err.message);
    return false;
  }
}
