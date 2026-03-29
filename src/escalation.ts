import type Database from 'better-sqlite3';
import { executeAction, type ActionResult } from './actions.js';
import { notify } from './notify.js';

// ============================================================
// Escalating Approval System for Staged Actions
//
// Prevents ADHD-driven action loss. Actions escalate:
//   Level 0 (0-24h):  Normal iMessage notification (already sent on creation)
//   Level 1 (24-48h): REMINDER prefix, second iMessage
//   Level 2 (48-72h): Email+confidence check -> "auto-send in 24h unless NO"
//   Level 3 (72h+):   Auto-execute if eligible, notify after
//
// Non-email types (reminders, calendar) auto-execute at Level 1.
// Runs every sync cycle (15 min) via scheduler.
// ============================================================

interface PendingAction {
  id: number;
  type: string;
  summary: string;
  reasoning: string | null;
  project: string | null;
  payload: string;
  created_at: string;
  escalation_level: number;
  last_escalated_at: string | null;
  auto_execute_eligible: number;
}

/**
 * Calculate how many hours have elapsed since the action was created.
 */
function hoursElapsed(createdAt: string): number {
  const created = new Date(createdAt + 'Z'); // SQLite datetime is UTC
  const now = new Date();
  return (now.getTime() - created.getTime()) / (1000 * 60 * 60);
}

/**
 * Determine the target escalation level based on action age.
 */
function targetLevel(hours: number): number {
  if (hours >= 72) return 3;
  if (hours >= 48) return 2;
  if (hours >= 24) return 1;
  return 0;
}

/**
 * Check if an email action's payload has confidence > 0.7.
 * Confidence can live in the payload JSON or in the reasoning field.
 */
function hasHighConfidence(action: PendingAction): boolean {
  try {
    const payload = JSON.parse(action.payload);
    if (typeof payload.confidence === 'number' && payload.confidence > 0.7) return true;
  } catch {}
  // If payload doesn't have explicit confidence, assume high confidence
  // since the action was already filtered at creation (confidence > 0.7 in dream.ts)
  return true;
}

/**
 * Run the escalation check. Called every sync cycle (15 min).
 * Returns a summary of what happened.
 */
export async function runEscalationCheck(db: Database.Database): Promise<{
  escalated: number;
  autoExecuted: number;
  errors: string[];
}> {
  const errors: string[] = [];
  let escalated = 0;
  let autoExecuted = 0;

  // Get all pending actions that haven't expired
  const pending = db.prepare(`
    SELECT id, type, summary, reasoning, project, payload, created_at,
           COALESCE(escalation_level, 0) as escalation_level,
           last_escalated_at,
           COALESCE(auto_execute_eligible, 0) as auto_execute_eligible
    FROM staged_actions
    WHERE status = 'pending'
      AND (expires_at IS NULL OR expires_at > datetime('now'))
    ORDER BY created_at ASC
  `).all() as PendingAction[];

  if (pending.length === 0) return { escalated: 0, autoExecuted: 0, errors: [] };

  for (const action of pending) {
    const hours = hoursElapsed(action.created_at);
    const target = targetLevel(hours);
    const current = action.escalation_level;

    // Skip if already at or past target level
    if (current >= target) continue;

    try {
      // ── Non-email types: auto-execute at Level 1 ──
      if (action.type !== 'email' && target >= 1 && current < 1) {
        const result = await executeAction(db, action.id);
        if (result.success) {
          // Update escalation metadata
          db.prepare(`
            UPDATE staged_actions
            SET escalation_level = 1, last_escalated_at = datetime('now')
            WHERE id = ?
          `).run(action.id);

          await notify(db, {
            title: `Auto-executed: ${action.type}`,
            body: `${action.summary}${action.project ? ` (${action.project})` : ''}`,
            urgency: 'fyi',
            agent: 'escalation',
          });

          autoExecuted++;
          console.log(`  [escalation] Auto-executed [${action.type}] #${action.id}: ${action.summary}`);
        } else {
          errors.push(`Auto-exec #${action.id} failed: ${result.message}`);
        }
        continue;
      }

      // ── Email escalation ladder ──
      if (target >= 3 && current < 3 && action.auto_execute_eligible) {
        // Level 3: Auto-execute eligible email
        const result = await executeAction(db, action.id);
        db.prepare(`
          UPDATE staged_actions
          SET escalation_level = 3, last_escalated_at = datetime('now')
          WHERE id = ?
        `).run(action.id);

        if (result.success) {
          await notify(db, {
            title: 'Auto-sent email',
            body: `Auto-sent: ${action.summary}${action.project ? ` (${action.project})` : ''}\n\nYou had 24h to reply NO. Action was executed automatically.`,
            urgency: 'high',
            agent: 'escalation',
          });
          autoExecuted++;
          console.log(`  [escalation] Auto-sent email #${action.id}: ${action.summary}`);
        } else {
          errors.push(`Auto-send #${action.id} failed: ${result.message}`);
        }

      } else if (target >= 2 && current < 2) {
        // Level 2: Mark auto-execute eligible if high confidence, warn user
        const eligible = action.type === 'email' && hasHighConfidence(action);

        db.prepare(`
          UPDATE staged_actions
          SET escalation_level = 2,
              last_escalated_at = datetime('now'),
              auto_execute_eligible = ?
          WHERE id = ?
        `).run(eligible ? 1 : 0, action.id);

        const warningBody = eligible
          ? `FINAL WARNING: "${action.summary}"${action.project ? ` (${action.project})` : ''}\n\nI will auto-send this email in 24h unless you reply NO.\nReply LATER to snooze 24h.`
          : `OVERDUE (48h+): "${action.summary}"${action.project ? ` (${action.project})` : ''}\n\nThis will expire soon. Reply YES to approve or NO to reject.`;

        await notify(db, {
          title: eligible ? 'AUTO-SEND WARNING' : 'OVERDUE Action',
          body: warningBody,
          urgency: 'high',
          agent: 'escalation',
          channels: ['imessage'],
          actionRequired: eligible ? 'Reply NO to cancel auto-send, LATER to snooze' : 'Reply YES or NO',
        });

        escalated++;
        console.log(`  [escalation] Level 2 (${eligible ? 'auto-send warning' : 'overdue'}) #${action.id}: ${action.summary}`);

      } else if (target >= 1 && current < 1) {
        // Level 1: Reminder iMessage
        db.prepare(`
          UPDATE staged_actions
          SET escalation_level = 1, last_escalated_at = datetime('now')
          WHERE id = ?
        `).run(action.id);

        await notify(db, {
          title: 'REMINDER: Pending Action',
          body: `REMINDER: [${action.type}] ${action.summary}${action.project ? ` (${action.project})` : ''}\n\nThis has been waiting 24h+. Reply YES to approve, NO to reject, LATER to snooze.`,
          urgency: 'high',
          agent: 'escalation',
          channels: ['imessage'],
          actionRequired: 'Approve, reject, or snooze',
        });

        escalated++;
        console.log(`  [escalation] Level 1 (reminder) #${action.id}: ${action.summary}`);
      }

    } catch (err: any) {
      errors.push(`Escalation #${action.id}: ${err.message?.slice(0, 100)}`);
    }
  }

  return { escalated, autoExecuted, errors };
}

/**
 * Snooze an action: reset escalation to 0, extend expiry by 24h.
 */
export function snoozeAction(db: Database.Database, actionId: number): boolean {
  const action = db.prepare(
    "SELECT id FROM staged_actions WHERE id = ? AND status = 'pending'"
  ).get(actionId) as any;

  if (!action) return false;

  db.prepare(`
    UPDATE staged_actions
    SET escalation_level = 0,
        last_escalated_at = NULL,
        auto_execute_eligible = 0,
        expires_at = datetime(COALESCE(expires_at, datetime('now')), '+24 hours')
    WHERE id = ?
  `).run(actionId);

  return true;
}

/**
 * Snooze ALL pending actions.
 */
export function snoozeAllPending(db: Database.Database): number {
  const pending = db.prepare(
    "SELECT id FROM staged_actions WHERE status = 'pending' AND (expires_at IS NULL OR expires_at > datetime('now'))"
  ).all() as any[];

  let snoozed = 0;
  for (const { id } of pending) {
    if (snoozeAction(db, id)) snoozed++;
  }
  return snoozed;
}
