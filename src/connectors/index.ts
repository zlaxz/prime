import type Database from 'better-sqlite3';
import { scanGmail, scanSentMail } from './gmail.js';
import { scanCalendar } from './calendar.js';
import { scanClaude, importClaudeConversations } from './claude.js';
import { scanCowork } from './cowork.js';
import { getConfig } from '../db.js';
import { join } from 'path';
import { homedir } from 'os';

export interface SyncResult {
  source: string;
  items: number;
  error?: string;
}

export async function syncAll(db: Database.Database): Promise<SyncResult[]> {
  const results: SyncResult[] = [];

  // Gmail
  const gmailTokens = getConfig(db, 'gmail_tokens');
  if (gmailTokens) {
    try {
      const { items } = await scanGmail(db, { days: 7, maxThreads: 50 });
      results.push({ source: 'gmail', items });
    } catch (err: any) {
      results.push({ source: 'gmail', items: 0, error: err.message });
    }
  }

  // Calendar
  const calTokens = getConfig(db, 'calendar_tokens');
  if (calTokens) {
    try {
      const { items } = await scanCalendar(db);
      results.push({ source: 'calendar', items });
    } catch (err: any) {
      results.push({ source: 'calendar', items: 0, error: err.message });
    }
  }

  // Claude.ai
  const claudeKey = getConfig(db, 'claude_session_key');
  if (claudeKey) {
    try {
      const { items } = await scanClaude(db, { days: 7, maxConversations: 50 });
      results.push({ source: 'claude', items });
    } catch (err: any) {
      results.push({ source: 'claude', items: 0, error: err.message });
    }
  }

  // Claude.ai conversations from laptop scan (bypasses Cloudflare)
  const laptopClaudeFile = join(homedir(), 'laptop-sources', 'claude-api', 'new_conversations.jsonl');
  try {
    const { existsSync, unlinkSync } = await import('fs');
    if (existsSync(laptopClaudeFile)) {
      const { items, conversations } = await importClaudeConversations(db, laptopClaudeFile);
      if (items > 0) {
        results.push({ source: 'claude-laptop', items });
        unlinkSync(laptopClaudeFile); // Remove after successful import
      }
    }
  } catch (err: any) {
    results.push({ source: 'claude-laptop', items: 0, error: err.message });
  }

  // Cowork (Claude Desktop agent sessions)
  const coworkConnected = getConfig(db, 'cowork_connected');
  if (coworkConnected) {
    try {
      const { items } = await scanCowork(db, { days: 7, maxSessions: 50 });
      results.push({ source: 'cowork', items });
    } catch (err: any) {
      results.push({ source: 'cowork', items: 0, error: err.message });
    }
  }

  // Cowork output files (work products: docs, PDFs, CSVs)
  if (coworkConnected) {
    try {
      const { execSync } = await import('child_process');
      execSync('npx tsx scripts/index-cowork-outputs.ts', { cwd: join(homedir(), 'GitHub', 'prime'), timeout: 60000, stdio: 'ignore' });
      results.push({ source: 'cowork-output', items: 0 }); // count tracked internally
    } catch {}
  }

  // Gmail Sent — corrects false awaiting_reply tags + captures Zach-initiated threads
  if (gmailTokens) {
    try {
      const sent = await scanSentMail(db, { days: 7, maxThreads: 100 });
      results.push({ source: 'gmail-sent', items: sent.corrected + sent.newItems });
    } catch (err: any) {
      results.push({ source: 'gmail-sent', items: 0, error: err.message });
    }
  }

  // ── CALENDAR-TRIGGERED MEETING PREP ──
  // After sync, check if there's a meeting in the next 2 hours.
  // If so, store it in graph_state for the COS to pick up via prime_proactive_alerts.
  try {
    const upcomingMeetings = db.prepare(`
      SELECT title, summary, source_date, metadata
      FROM knowledge_primary
      WHERE source = 'calendar'
        AND source_date >= datetime('now')
        AND source_date <= datetime('now', '+2 hours')
      ORDER BY source_date ASC
    `).all() as any[];

    if (upcomingMeetings.length > 0) {
      const meetingPrep = upcomingMeetings.map((m: any) => {
        let attendees: string[] = [];
        try {
          const meta = typeof m.metadata === 'string' ? JSON.parse(m.metadata) : m.metadata || {};
          attendees = (meta.attendee_details || []).map((a: any) => a.displayName || a.email || '').filter(Boolean);
          if (!attendees.length && meta.attendees) attendees = meta.attendees;
        } catch {}
        return {
          title: m.title,
          time: m.source_date,
          summary: m.summary,
          attendees,
        };
      });

      db.prepare(
        "INSERT OR REPLACE INTO graph_state (key, value, updated_at) VALUES ('upcoming_meeting_prep', ?, datetime('now'))"
      ).run(JSON.stringify(meetingPrep));

      console.log(`  📅 MEETING PREP: ${upcomingMeetings.length} meeting(s) in next 2 hours`);
    }
  } catch {}

  // ── EVENT-DRIVEN TRIGGER LAYER ──
  // After sync, check if any new items from high-priority entities arrived.
  // If so, trigger immediate analysis instead of waiting for dream pipeline.
  try {
    const newGmailItems = results.find(r => r.source === 'gmail')?.items || 0;
    const newGmailSent = results.find(r => r.source === 'gmail-sent')?.items || 0;

    if (newGmailItems > 0 || newGmailSent > 0) {
      // Find new items from the last 15 min that involve key entities
      const recentHighPriority = db.prepare(`
        SELECT k.id, k.title, k.source, k.contacts, k.project, k.source_date,
          e.canonical_name as entity_name, e.user_label as entity_context
        FROM knowledge k
        JOIN entity_mentions em ON k.id = em.knowledge_item_id
        JOIN entities e ON em.entity_id = e.id
        WHERE k.created_at >= datetime('now', '-20 minutes')
          AND k.source IN ('gmail', 'gmail-sent')
          AND e.user_dismissed = 0
          AND (e.user_label IS NOT NULL OR e.relationship_type IN ('partner', 'key-contact', 'client'))
        ORDER BY k.source_date DESC
        LIMIT 5
      `).all() as any[];

      if (recentHighPriority.length > 0) {
        // Store as proactive alerts for the COS to pick up
        const alertData = recentHighPriority.map((item: any) => ({
          title: item.title,
          entity: item.entity_name,
          context: item.entity_context,
          project: item.project,
          source_date: item.source_date,
        }));

        db.prepare(
          "INSERT OR REPLACE INTO graph_state (key, value, updated_at) VALUES ('proactive_alerts', ?, datetime('now'))"
        ).run(JSON.stringify(alertData));

        console.log(`  ⚡ PROACTIVE: ${recentHighPriority.length} new items from key entities`);
      }
    }
  } catch {}

  return results;
}
