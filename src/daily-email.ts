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

    // Build the email body
    const lines: string[] = [];

    // Headline
    lines.push(brief.headline || 'No headline available');
    lines.push('');
    lines.push('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    lines.push('');

    // The One Thing
    lines.push('THE ONE THING:');
    lines.push(brief.the_one_thing || 'Run the intelligence cycle');
    lines.push('');

    // Actions
    if (actions.length > 0) {
      lines.push('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
      lines.push('ACTIONS');
      lines.push('');
      for (const a of actions) {
        lines.push(`#${a.priority} [${a.type?.toUpperCase()} | ${a.deadline}] ${a.title}`);
        if (a.target_person) lines.push(`   → ${a.target_person}`);
        lines.push(`   ${a.rationale}`);
        if (a.draft) {
          lines.push('');
          lines.push('   DRAFT:');
          for (const line of a.draft.split('\n')) {
            lines.push(`   ${line}`);
          }
        }
        lines.push('');
      }
    }

    // Top hypotheses
    if (brief.hypotheses?.length > 0) {
      lines.push('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
      lines.push('HYPOTHESES');
      lines.push('');
      for (const h of brief.hypotheses.slice(0, 4)) {
        lines.push(`[${h.confidence}%] ${h.claim}`);
        lines.push(`   Action: ${h.action}`);
        lines.push('');
      }
    }

    // Theories of mind
    if (brief.theories_of_mind?.length > 0) {
      lines.push('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
      lines.push('THEORIES OF MIND');
      lines.push('');
      for (const t of brief.theories_of_mind.slice(0, 3)) {
        lines.push(`${t.entity}: ${t.behavior_hypothesis}`);
        lines.push(`   Next move: ${t.likely_next_move}`);
        lines.push('');
      }
    }

    // Contradictions
    if (brief.contradictions?.length > 0) {
      lines.push('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
      lines.push('CONTRADICTIONS');
      lines.push('');
      for (const c of brief.contradictions) {
        lines.push(`⚠ ${c.tension}`);
        lines.push(`   → ${c.resolution}`);
        lines.push('');
      }
    }

    // Footer
    lines.push('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    lines.push('');
    lines.push(`Generated ${new Date().toLocaleString('en-US', { timeZone: 'America/Denver', weekday: 'long', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit' })}`);
    lines.push(`Knowledge base: ${(db.prepare('SELECT COUNT(*) as c FROM knowledge').get() as any)?.c || '?'} items`);
    if (quality.issues?.length > 0) lines.push(`Quality: ${quality.issues.length} issues caught`);
    if (health.issues?.length > 0) lines.push(`System: ${health.issues.join(', ')}`);
    lines.push('');
    lines.push('— Quinn Parker');
    lines.push('   AI Chief of Staff, Recapture Insurance');

    const body = lines.join('\n');
    const subject = `${brief.headline?.slice(0, 80) || 'Daily Intelligence Brief'}`;

    const result = await sendEmail(db, {
      to: 'zach.stock@recaptureinsurance.com',
      subject,
      body,
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
