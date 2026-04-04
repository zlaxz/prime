import { getDb, getConfig } from './db.js';
import { syncAll } from './connectors/index.js';

// ============================================================
// Prime Shift Daemon — Active autonomous monitoring
//
// Runs from 7am to 10pm. Makes Prime feel alive:
// - Every 15 min: sync data, check for signals
// - Every hour: meeting prep, commitment checks
// - Every 4 hours: full intelligence cycle + research + playbooks
//
// This replaces the 3x daily cron with continuous awareness.
// ============================================================

const CYCLE_INTERVAL = 15 * 60 * 1000;  // 15 minutes
const HOUR_MS = 60 * 60 * 1000;

async function tick() {
  const db = getDb();
  const now = new Date();
  const hour = now.getHours();

  // Only work between 7am and 10pm
  if (hour < 7 || hour >= 22) {
    console.log(`[shift] ${now.toLocaleTimeString()} — Off hours. Sleeping.`);
    return;
  }

  console.log(`[shift] ${now.toLocaleTimeString()} — Tick starting...`);

  // ── EVERY TICK (15 min): Sync data ──
  try {
    const syncResults = await syncAll(db);
    const totalSynced = syncResults.reduce((s, r) => s + r.items, 0);
    if (totalSynced > 0) {
      console.log(`[shift]   Synced ${totalSynced} items`);
    }
    // Event-driven intelligence is already wired into syncAll
    // (triggers when key entity emails detected)
  } catch (err: any) {
    console.log(`[shift]   Sync error: ${err.message?.slice(0, 60)}`);
  }

  // ── HOURLY: Meeting prep + commitment checks ──
  const lastHourlyRaw = (db.prepare("SELECT value FROM graph_state WHERE key = 'last_hourly_check'").get() as any)?.value;
  const lastHourly = lastHourlyRaw ? new Date(JSON.parse(lastHourlyRaw)).getTime() : 0;

  if (Date.now() - lastHourly > HOUR_MS) {
    console.log(`[shift]   Running hourly checks...`);

    // Meeting prep for next 2 hours
    try {
      const meetings = db.prepare(`
        SELECT title, source_date, metadata FROM knowledge_primary
        WHERE source = 'calendar'
          AND source_date >= datetime('now')
          AND source_date <= datetime('now', '+2 hours')
        ORDER BY source_date ASC LIMIT 3
      `).all() as any[];

      if (meetings.length > 0) {
        console.log(`[shift]   📅 ${meetings.length} meeting(s) in next 2 hours`);
        // Meeting prep is already handled by Task 12 in the dream pipeline
        // Store a flag so the next intelligence cycle emphasizes it
        db.prepare(
          "INSERT OR REPLACE INTO graph_state (key, value, updated_at) VALUES ('upcoming_meeting_alert', ?, datetime('now'))"
        ).run(JSON.stringify(meetings.map((m: any) => ({ title: m.title, time: m.source_date }))));
      }
    } catch {}

    // Commitment deadline check — anything due in next 24 hours
    try {
      const urgentCommitments = db.prepare(`
        SELECT text, owner, project, due_date, state FROM commitments
        WHERE state IN ('active', 'overdue')
          AND due_date IS NOT NULL
          AND due_date <= datetime('now', '+24 hours')
          AND due_date >= datetime('now', '-48 hours')
        ORDER BY due_date ASC
      `).all() as any[];

      if (urgentCommitments.length > 0) {
        console.log(`[shift]   ⚠️ ${urgentCommitments.length} commitment(s) due in 24h`);
        db.prepare(
          "INSERT OR REPLACE INTO graph_state (key, value, updated_at) VALUES ('urgent_commitments', ?, datetime('now'))"
        ).run(JSON.stringify(urgentCommitments));
      }
    } catch {}

    db.prepare(
      "INSERT OR REPLACE INTO graph_state (key, value, updated_at) VALUES ('last_hourly_check', ?, datetime('now'))"
    ).run(JSON.stringify(new Date().toISOString()));
  }

  // ── EVERY 4 HOURS: Full intelligence cycle + research + playbooks ──
  const lastFullRaw = (db.prepare("SELECT value FROM graph_state WHERE key = 'last_full_cycle'").get() as any)?.value;
  const lastFull = lastFullRaw ? new Date(JSON.parse(lastFullRaw)).getTime() : 0;

  if (Date.now() - lastFull > 4 * HOUR_MS) {
    console.log(`[shift]   Running full intelligence cycle...`);

    try {
      const { runIntelligenceCycle } = await import('./intelligence-cycle.js');
      const result = await runIntelligenceCycle(db);
      console.log(`[shift]   Intelligence: ${result.status} (${result.duration_seconds.toFixed(0)}s) — ${result.output?.headline?.slice(0, 60) || ''}`);
    } catch (err: any) {
      console.log(`[shift]   Intelligence failed: ${err.message?.slice(0, 60)}`);
    }

    try {
      const { runAutonomousResearch } = await import('./research.js');
      const result = await runAutonomousResearch(db);
      if (result.status === 'success') {
        console.log(`[shift]   Research: ${result.output?.questions_researched} questions answered`);
      }
    } catch {}

    try {
      const { extractPlaybooks } = await import('./playbooks.js');
      const result = await extractPlaybooks(db);
      if (result.status === 'success') {
        console.log(`[shift]   Playbooks: ${result.output?.playbooks_extracted} extracted`);
      }
    } catch {}

    db.prepare(
      "INSERT OR REPLACE INTO graph_state (key, value, updated_at) VALUES ('last_full_cycle', ?, datetime('now'))"
    ).run(JSON.stringify(new Date().toISOString()));
  }

  console.log(`[shift] ${now.toLocaleTimeString()} — Tick complete.`);
}

// ── Main loop ──
async function main() {
  console.log(`[shift] Prime Shift Daemon starting. Active hours: 7am-10pm. Cycle: ${CYCLE_INTERVAL / 60000} min.`);

  // Run immediately on start
  await tick();

  // Then loop
  setInterval(async () => {
    try {
      await tick();
    } catch (err: any) {
      console.error(`[shift] Tick error: ${err.message}`);
    }
  }, CYCLE_INTERVAL);
}

main().catch(err => {
  console.error(`[shift] Fatal: ${err.message}`);
  process.exit(1);
});
