import type Database from 'better-sqlite3';
import { scanGmail, scanSentMail } from './gmail.js';
import { scanCalendar } from './calendar.js';
import { scanClaude } from './claude.js';
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

  return results;
}
