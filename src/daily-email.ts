import type Database from 'better-sqlite3';
import { sendEmail } from './connectors/gmail.js';

// ============================================================
// Quinn's Daily Intelligence Email
//
// Sent to Zach every morning after the intelligence cycle.
// Arrives in his inbox — no app to open, no dashboard to check.
// ============================================================

export async function sendDailyIntelligenceEmail(db: Database.Database): Promise<boolean> {
  try {
    // Load the intelligence brief
    const briefRaw = (db.prepare("SELECT value FROM graph_state WHERE key = 'intelligence_brief'").get() as any)?.value;
    if (!briefRaw) { console.log('[quinn] No intelligence brief to send'); return false; }
    const brief = JSON.parse(briefRaw);

    // Load actions
    const actionsRaw = (db.prepare("SELECT value FROM graph_state WHERE key = 'intelligence_actions'").get() as any)?.value;
    const actions = actionsRaw ? JSON.parse(actionsRaw) : [];

    // Load quality issues
    const qualityRaw = (db.prepare("SELECT value FROM graph_state WHERE key = 'intelligence_quality'").get() as any)?.value;
    const quality = qualityRaw ? JSON.parse(qualityRaw) : {};

    // Load system health
    const healthRaw = (db.prepare("SELECT value FROM graph_state WHERE key = 'system_health'").get() as any)?.value;
    const health = healthRaw ? JSON.parse(healthRaw) : {};

    // Build HTML email
    const esc = (s: string) => (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br>');
    const date = new Date().toLocaleDateString('en-US', { timeZone: 'America/Denver', weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
    const kbCount = (db.prepare('SELECT COUNT(*) as c FROM knowledge').get() as any)?.c || '?';

    const deadlineColor: Record<string, string> = { today: '#ef4444', tomorrow: '#f97316', this_week: '#3b82f6', this_month: '#6b7280' };
    const typeColor: Record<string, string> = { email: '#06b6d4', call: '#22c55e', prepare: '#eab308', decide: '#f97316', investigate: '#a855f7', wait: '#6b7280' };

    let html = `
<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"></head>
<body style="margin:0;padding:0;background:#0a0e12;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
<div style="max-width:640px;margin:0 auto;padding:24px 16px;">

  <!-- Header -->
  <div style="padding:20px 24px;border-left:4px solid #06b6d4;background:rgba(6,182,212,0.05);border-radius:0 8px 8px 0;margin-bottom:24px;">
    <div style="font-size:11px;font-weight:600;letter-spacing:2px;color:#06b6d4;text-transform:uppercase;margin-bottom:8px;">Prime Intelligence</div>
    <div style="font-size:22px;font-weight:300;color:#e2e8f0;line-height:1.3;">${esc(brief.headline || 'No headline')}</div>
  </div>

  <!-- The One Thing -->
  <div style="padding:16px 20px;background:#111827;border-radius:8px;margin-bottom:24px;">
    <div style="font-size:10px;font-weight:600;letter-spacing:2px;color:#06b6d4;text-transform:uppercase;margin-bottom:6px;">The One Thing</div>
    <div style="font-size:15px;color:#cbd5e1;line-height:1.5;">${esc(brief.the_one_thing || '')}</div>
  </div>`;

    // Actions
    if (actions.length > 0) {
      html += `<div style="margin-bottom:24px;">
        <div style="font-size:12px;font-weight:600;letter-spacing:1px;color:#94a3b8;text-transform:uppercase;margin-bottom:12px;">Actions</div>`;
      for (const a of actions) {
        const tc = typeColor[a.type] || '#6b7280';
        const dc = deadlineColor[a.deadline] || '#6b7280';
        html += `<div style="padding:16px;background:#111827;border-radius:8px;margin-bottom:8px;border-left:3px solid ${tc};">
          <div style="margin-bottom:6px;">
            <span style="font-size:10px;font-weight:700;color:${tc};text-transform:uppercase;padding:2px 6px;background:rgba(6,182,212,0.1);border-radius:4px;">${esc(a.type)}</span>
            <span style="font-size:10px;font-weight:700;color:${dc};margin-left:6px;">${esc(a.deadline?.replace('_', ' '))}</span>
          </div>
          <div style="font-size:14px;font-weight:600;color:#e2e8f0;">${esc(a.title)}</div>
          ${a.target_person ? `<div style="font-size:13px;color:#06b6d4;margin-top:2px;">→ ${esc(a.target_person)}</div>` : ''}
          <div style="font-size:13px;color:#94a3b8;margin-top:6px;line-height:1.4;">${esc(a.rationale)}</div>
          ${a.draft ? `<div style="margin-top:10px;padding:12px;background:#0a0e12;border-left:2px solid #06b6d4;border-radius:4px;font-size:12px;color:#94a3b8;line-height:1.5;white-space:pre-wrap;">${esc(a.draft)}</div>` : ''}
        </div>`;
      }
      html += `</div>`;
    }

    // Hypotheses
    if (brief.hypotheses?.length > 0) {
      html += `<div style="margin-bottom:24px;">
        <div style="font-size:12px;font-weight:600;letter-spacing:1px;color:#94a3b8;text-transform:uppercase;margin-bottom:12px;">Hypotheses</div>`;
      for (const h of brief.hypotheses.slice(0, 4)) {
        const barWidth = Math.min(h.confidence, 100);
        const barColor = h.confidence >= 70 ? '#22c55e' : h.confidence >= 50 ? '#eab308' : '#ef4444';
        html += `<div style="padding:12px 16px;background:#111827;border-radius:8px;margin-bottom:6px;">
          <div style="display:flex;align-items:center;gap:8px;margin-bottom:4px;">
            <div style="width:40px;height:4px;background:#1e293b;border-radius:2px;overflow:hidden;"><div style="width:${barWidth}%;height:100%;background:${barColor};border-radius:2px;"></div></div>
            <span style="font-size:11px;font-weight:600;color:${barColor};">${h.confidence}%</span>
          </div>
          <div style="font-size:13px;color:#e2e8f0;">${esc(h.claim)}</div>
          <div style="font-size:12px;color:#64748b;margin-top:4px;">Action: ${esc(h.action)}</div>
        </div>`;
      }
      html += `</div>`;
    }

    // Theories of Mind
    if (brief.theories_of_mind?.length > 0) {
      html += `<div style="margin-bottom:24px;">
        <div style="font-size:12px;font-weight:600;letter-spacing:1px;color:#94a3b8;text-transform:uppercase;margin-bottom:12px;">Theories of Mind</div>`;
      for (const t of brief.theories_of_mind.slice(0, 3)) {
        html += `<div style="padding:12px 16px;background:#111827;border-radius:8px;margin-bottom:6px;">
          <div style="font-size:13px;font-weight:600;color:#06b6d4;">${esc(t.entity)}</div>
          <div style="font-size:13px;color:#cbd5e1;margin-top:4px;line-height:1.4;">${esc(t.behavior_hypothesis)}</div>
          <div style="font-size:12px;color:#64748b;margin-top:4px;">Next move: ${esc(t.likely_next_move)}</div>
        </div>`;
      }
      html += `</div>`;
    }

    // Contradictions
    if (brief.contradictions?.length > 0) {
      html += `<div style="margin-bottom:24px;">
        <div style="font-size:12px;font-weight:600;letter-spacing:1px;color:#f59e0b;text-transform:uppercase;margin-bottom:12px;">Contradictions</div>`;
      for (const c of brief.contradictions) {
        html += `<div style="padding:12px 16px;background:rgba(245,158,11,0.05);border:1px solid rgba(245,158,11,0.15);border-radius:8px;margin-bottom:6px;">
          <div style="font-size:13px;color:#fbbf24;">${esc(c.tension)}</div>
          <div style="font-size:12px;color:#94a3b8;margin-top:4px;">→ ${esc(c.resolution)}</div>
        </div>`;
      }
      html += `</div>`;
    }

    // Footer
    html += `
  <div style="padding-top:16px;border-top:1px solid #1e293b;margin-top:24px;">
    <div style="font-size:11px;color:#475569;">${date} | ${kbCount} knowledge items${quality.issues?.length ? ` | ${quality.issues.length} quality issues caught` : ''}</div>
    <div style="margin-top:12px;">
      <div style="font-size:13px;font-weight:500;color:#94a3b8;">Quinn Parker</div>
      <div style="font-size:11px;color:#475569;">AI Chief of Staff, Recapture Insurance</div>
    </div>
    <div style="font-size:10px;color:#334155;margin-top:12px;">Reply to this email to update Prime. Your response will be ingested automatically.</div>
  </div>

</div></body></html>`;

    // Clean subject — replace em-dashes and special chars that garble in email headers
    const rawSubject = brief.headline?.slice(0, 80) || 'Daily Intelligence Brief';
    const subject = rawSubject.replace(/—/g, '-').replace(/[^\x20-\x7E]/g, '');
    const body = html;

    const result = await sendEmail(db, {
      to: 'zach.stock@recaptureinsurance.com',
      subject,
      body,
      html: true,
    });

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
