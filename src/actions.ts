import type Database from 'better-sqlite3';
import { getConfig } from './db.js';

// ============================================================
// Staged Action Executor — shared by MCP approve + iMessage listener
// ============================================================

export interface ActionResult {
  success: boolean;
  message: string;
  actionId: number;
}

/**
 * Execute a single staged action by ID.
 * Handles email, calendar, reminder types.
 */
export async function executeAction(db: Database.Database, id: number): Promise<ActionResult> {
  const action = db.prepare("SELECT * FROM staged_actions WHERE id = ? AND status = 'pending'").get(id) as any;

  if (!action) {
    return { success: false, message: `Action ${id} not found or already processed.`, actionId: id };
  }

  const payload = JSON.parse(action.payload);

  try {
    let result = '';

    if (action.type === 'email' && payload.to) {
      const { sendEmail } = await import('./connectors/gmail.js');
      const sendResult = await sendEmail(db, {
        to: payload.to,
        subject: payload.subject || 'Follow up',
        body: payload.body || '',
        cc: payload.cc,
      });
      if (sendResult.success) {
        result = `Email sent to ${payload.to}: "${payload.subject}"`;
      } else {
        throw new Error(sendResult.error || 'Email send failed');
      }
    } else if (action.type === 'calendar' && payload.title) {
      const { google } = await import('googleapis');
      const tokens = getConfig(db, 'gmail_tokens');
      if (!tokens) throw new Error('Calendar not connected');

      const oauth2 = new google.auth.OAuth2(
        getConfig(db, 'google_client_id') || process.env.GOOGLE_CLIENT_ID || '',
        getConfig(db, 'google_client_secret') || process.env.GOOGLE_CLIENT_SECRET || '',
        'http://localhost:9876/callback'
      );
      oauth2.setCredentials(typeof tokens === 'string' ? JSON.parse(tokens) : tokens);
      const calendar = google.calendar({ version: 'v3', auth: oauth2 });

      const startTime = payload.start_time ? new Date(payload.start_time) : new Date(Date.now() + 24 * 3600000);
      const duration = payload.duration_min || 30;
      const endTime = new Date(startTime.getTime() + duration * 60000);

      await calendar.events.insert({
        calendarId: 'primary',
        requestBody: {
          summary: payload.title,
          description: payload.description || action.reasoning || '',
          start: { dateTime: startTime.toISOString() },
          end: { dateTime: endTime.toISOString() },
          attendees: payload.attendees?.map((e: string) => ({ email: e })),
        },
      });
      result = `Calendar: "${payload.title}" on ${startTime.toLocaleDateString()}`;
    } else if (action.type === 'reminder') {
      result = `Reminder noted: "${payload.text || action.summary}"`;
    } else {
      result = `Approved: ${action.summary}`;
    }

    db.prepare("UPDATE staged_actions SET status = 'executed', acted_at = datetime('now') WHERE id = ?").run(id);
    return { success: true, message: result, actionId: id };
  } catch (err: any) {
    return { success: false, message: `Failed: ${err.message}`, actionId: id };
  }
}

/**
 * Execute all pending staged actions.
 */
export async function executeAllPending(db: Database.Database): Promise<ActionResult[]> {
  const pending = db.prepare(
    "SELECT id FROM staged_actions WHERE status = 'pending' AND (expires_at IS NULL OR expires_at > datetime('now')) ORDER BY id"
  ).all() as any[];

  const results: ActionResult[] = [];
  for (const { id } of pending) {
    results.push(await executeAction(db, id));
  }
  return results;
}

/**
 * Auto-execute low-risk actions (reminders, calendar blocks).
 * Returns executed actions. Leaves emails for manual approval.
 */
export async function autoExecuteLowRisk(db: Database.Database): Promise<ActionResult[]> {
  const lowRisk = db.prepare(
    "SELECT id, type FROM staged_actions WHERE status = 'pending' AND type IN ('reminder', 'calendar') AND (expires_at IS NULL OR expires_at > datetime('now')) ORDER BY id"
  ).all() as any[];

  const results: ActionResult[] = [];
  for (const { id } of lowRisk) {
    results.push(await executeAction(db, id));
  }
  return results;
}
