/**
 * Mass Sent Mail Ingestion — 14 months of sent email history
 *
 * Mirrors mass-gmail-ingest.ts but queries `from:me` for sent mail.
 * Includes Phase C correction: removes awaiting_reply tags from matching
 * inbox items when a sent reply is found by subject match.
 *
 * Usage: cd ~/GitHub/prime && npx tsx scripts/mass-sent-ingest.ts
 */

import { getDb, getConfig, setConfig, insertKnowledge, type KnowledgeItem } from '../src/db.js';
import { extractIntelligenceV2, toV1 } from '../src/ai/extract.js';
import { google } from 'googleapis';
import { v4 as uuid } from 'uuid';

const db = getDb();
const DAYS = 425; // ~14 months
const MAX_THREADS = 10000;
const EXTRACTION_CONCURRENCY = 100; // DeepSeek swarm

// Ensure DeepSeek API key is available
if (!process.env.DEEPSEEK_API_KEY) {
  // Try DB first
  const dbKey = db.prepare("SELECT value FROM config WHERE key = 'deepseek_api_key'").get() as any;
  if (dbKey?.value) {
    process.env.DEEPSEEK_API_KEY = dbKey.value.replace(/^"|"$/g, ''); // strip quotes if JSON-wrapped
    console.log('Loaded DeepSeek key from DB config');
  }
  // Try .env file directly
  if (!process.env.DEEPSEEK_API_KEY) {
    try {
      const envFile = require('fs').readFileSync(require('path').join(require('os').homedir(), 'GitHub', 'prime', '.env'), 'utf-8');
      const match = envFile.match(/DEEPSEEK_API_KEY=(.+)/);
      if (match) {
        process.env.DEEPSEEK_API_KEY = match[1].trim();
        console.log('Loaded DeepSeek key from .env file');
      }
    } catch {}
  }
  if (!process.env.DEEPSEEK_API_KEY) {
    console.error('No DEEPSEEK_API_KEY found anywhere');
    process.exit(1);
  }
}
console.log('DeepSeek key:', process.env.DEEPSEEK_API_KEY?.slice(0, 10) + '...');

const CLIENT_ID = getConfig(db, 'google_client_id') || process.env.GOOGLE_CLIENT_ID || '';
const CLIENT_SECRET = getConfig(db, 'google_client_secret') || process.env.GOOGLE_CLIENT_SECRET || '';
const REDIRECT_URI = 'http://localhost:3210/auth/google/callback';

async function main() {
  console.log(`\n📤 MASS SENT MAIL INGESTION — ${DAYS} days, up to ${MAX_THREADS} threads, ${EXTRACTION_CONCURRENCY} concurrent agents\n`);

  const tokens = getConfig(db, 'gmail_tokens');
  if (!tokens) { console.error('No Gmail tokens'); process.exit(1); }

  const oauth2Client = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI);
  oauth2Client.setCredentials(tokens);
  oauth2Client.on('tokens', (newTokens) => {
    const current = getConfig(db, 'gmail_tokens');
    setConfig(db, 'gmail_tokens', { ...current, ...newTokens });
  });

  try {
    const { credentials } = await oauth2Client.refreshAccessToken();
    oauth2Client.setCredentials(credentials);
    setConfig(db, 'gmail_tokens', credentials);
  } catch (err: any) {
    console.error('Token refresh failed:', err.message);
    process.exit(1);
  }

  const gmail = google.gmail({ version: 'v1', auth: oauth2Client });
  const userEmail = getConfig(db, 'gmail_email') || '';
  const afterDate = new Date(Date.now() - DAYS * 86400000);
  const afterEpoch = Math.floor(afterDate.getTime() / 1000);

  // ── Phase 1: Fetch ALL sent thread IDs ──
  console.log(`Phase 1: Fetching sent threads since ${afterDate.toISOString().slice(0, 10)}...`);
  const allThreads: { id: string }[] = [];
  let pageToken: string | undefined;

  while (allThreads.length < MAX_THREADS) {
    const response = await gmail.users.threads.list({
      userId: 'me',
      maxResults: 500,
      q: `from:me after:${afterEpoch}`,
      pageToken,
    });
    const batch = response.data.threads || [];
    for (const t of batch) {
      if (t.id) allThreads.push({ id: t.id });
    }
    pageToken = response.data.nextPageToken || undefined;
    if (!pageToken || batch.length === 0) break;
    process.stdout.write(`\r  ${allThreads.length} threads found...`);
  }
  console.log(`\n  Total: ${allThreads.length} sent threads\n`);

  // ── Phase 2: Filter out already-indexed threads ──
  const existingRefs = new Set<string>();
  const existing = db.prepare("SELECT source_ref FROM knowledge WHERE source IN ('gmail', 'gmail-sent')").all() as any[];
  for (const e of existing) existingRefs.add(e.source_ref);

  const newThreads = allThreads.filter(t => !existingRefs.has(`thread:${t.id}`));
  console.log(`Phase 2: ${newThreads.length} new threads (${allThreads.length - newThreads.length} already indexed)\n`);

  // ── Phase 3: Fetch thread metadata (fast, parallel) ──
  console.log(`Phase 3: Fetching thread metadata (50 concurrent)...`);
  const getHeader = (msg: any, name: string) =>
    msg.payload?.headers?.find((h: any) => h.name === name)?.value || '';

  type ThreadData = {
    id: string;
    subject: string;
    from: string;
    to: string;
    date: string;
    snippet: string;
    messageCount: number;
    body: string;
    userSentLast: boolean;
  };

  const threadData: ThreadData[] = [];
  const META_CONCURRENCY = 50;

  for (let i = 0; i < newThreads.length; i += META_CONCURRENCY) {
    const batch = newThreads.slice(i, i + META_CONCURRENCY);
    const results = await Promise.all(batch.map(async (t) => {
      try {
        const thread = await gmail.users.threads.get({
          userId: 'me',
          id: t.id,
          format: 'full',
        });
        const messages = thread.data.messages || [];
        if (messages.length === 0) return null;

        const first = messages[0];
        const last = messages[messages.length - 1];

        // Extract body text from the last message
        let body = '';
        const extractText = (part: any): string => {
          if (part.mimeType === 'text/plain' && part.body?.data) {
            return Buffer.from(part.body.data, 'base64').toString('utf-8');
          }
          if (part.parts) {
            return part.parts.map(extractText).join('\n');
          }
          return '';
        };
        body = extractText(last.payload).slice(0, 5000);

        const lastFrom = getHeader(last, 'From');

        return {
          id: t.id,
          subject: getHeader(first, 'Subject'),
          from: getHeader(first, 'From'),
          to: getHeader(first, 'To'),
          date: getHeader(last, 'Date'),
          snippet: last.snippet || '',
          messageCount: messages.length,
          body,
          userSentLast: lastFrom.toLowerCase().includes(userEmail.toLowerCase()),
        } as ThreadData;
      } catch { return null; }
    }));

    for (const r of results) {
      if (r) threadData.push(r);
    }

    if ((i + META_CONCURRENCY) % 200 === 0 || i + META_CONCURRENCY >= newThreads.length) {
      process.stdout.write(`\r  Fetched: ${Math.min(i + META_CONCURRENCY, newThreads.length)}/${newThreads.length}`);
    }
  }
  console.log(`\n  ${threadData.length} threads with data\n`);

  // ── Phase C: Correct existing inbox items (remove false awaiting_reply) ──
  // This runs BEFORE extraction so corrections happen even if extraction fails.
  console.log('Phase C: Correcting false awaiting_reply tags on existing inbox items...');
  let corrected = 0;

  for (const td of threadData) {
    // Skip threads where user did NOT send the last message — no correction needed
    if (!td.userSentLast) continue;

    // Strip Re:/Fwd: prefixes for subject matching
    const cleanSubject = td.subject.replace(/^(Re:|Fwd:)\s*/gi, '').trim();
    if (!cleanSubject) continue;

    // Try matching by thread ID first, then by subject in inbox items
    const sourceRef = `thread:${td.id}`;
    let existingItem = db.prepare(
      'SELECT id, metadata, tags FROM knowledge WHERE source_ref = ? AND source = ?'
    ).get(sourceRef, 'gmail') as any;

    if (!existingItem) {
      existingItem = db.prepare(
        "SELECT id, metadata, tags FROM knowledge WHERE source = 'gmail' AND title LIKE ? ORDER BY source_date DESC LIMIT 1"
      ).get(`%${cleanSubject.slice(0, 50)}%`) as any;
    }

    if (existingItem) {
      const meta = typeof existingItem.metadata === 'string' ? JSON.parse(existingItem.metadata) : (existingItem.metadata || {});
      const tags = typeof existingItem.tags === 'string' ? JSON.parse(existingItem.tags) : (existingItem.tags || []);

      if (tags.includes('awaiting_reply') || meta.waiting_on_user) {
        const newTags = tags.filter((t: string) => t !== 'awaiting_reply');
        const newMeta = {
          ...meta,
          waiting_on_user: false,
          user_replied: true,
          replied_at: td.date ? new Date(td.date).toISOString() : new Date().toISOString(),
          corrected_by: 'mass-sent-ingest',
        };

        db.prepare(
          "UPDATE knowledge SET tags = ?, metadata = ?, updated_at = datetime('now') WHERE id = ?"
        ).run(JSON.stringify(newTags), JSON.stringify(newMeta), existingItem.id);

        corrected++;
      }
    }
  }
  console.log(`  ${corrected} items corrected (awaiting_reply removed)\n`);

  // ── Phase 4: AI extraction with DeepSeek swarm (100 concurrent) ──
  // Only extract threads that are genuinely new (not already indexed)
  const threadsToExtract = threadData.filter(td => !existingRefs.has(`thread:${td.id}`));

  if (threadsToExtract.length === 0) {
    console.log('No new threads to extract. Done!\n');
    db.prepare(
      `INSERT OR REPLACE INTO sync_state (source, last_sync_at, items_synced, status, updated_at)
       VALUES ('gmail-sent-mass-ingest', datetime('now'), ?, 'complete', datetime('now'))`
    ).run(corrected);
    return;
  }

  console.log(`Phase 4: AI extraction (${EXTRACTION_CONCURRENCY} concurrent DeepSeek agents) on ${threadsToExtract.length} threads...`);

  let extracted = 0;
  let failed = 0;

  for (let i = 0; i < threadsToExtract.length; i += EXTRACTION_CONCURRENCY) {
    const batch = threadsToExtract.slice(i, i + EXTRACTION_CONCURRENCY);

    await Promise.all(batch.map(async (td) => {
      try {
        const content = `Sent email thread: "${td.subject}"\nFrom: ${td.from}\nTo: ${td.to}\nDate: ${td.date}\nMessages: ${td.messageCount}\n\n${td.body}`;

        const result = await extractIntelligenceV2(content, {
          source: 'gmail-sent',
          apiKey: getConfig(db, 'openai_api_key'),
        } as any);
        const v1 = toV1(result);

        // Skip embedding for mass ingest — will batch-generate after
        const embedding: number[] = [];

        const daysSince = td.date ? Math.floor((Date.now() - new Date(td.date).getTime()) / 86400000) : 0;

        const item: KnowledgeItem = {
          id: uuid(),
          title: v1.title || `Sent: ${td.subject}`,
          summary: v1.summary || td.snippet,
          source: 'gmail-sent',
          source_ref: `thread:${td.id}`,
          source_date: td.date ? new Date(td.date).toISOString() : new Date().toISOString(),
          contacts: v1.contacts || [],
          commitments: v1.commitments || [],
          embedding,
          importance: v1.importance || 'normal',
          project: v1.project || null,
          tags: [...(v1.tags || []), 'sent', 'user-initiated', ...(td.userSentLast ? [] : ['awaiting_reply_from_them'])],
          metadata: {
            from: td.from,
            to: td.to,
            subject: td.subject,
            message_count: td.messageCount,
            raw_body_length: td.body.length,
            days_since_last: daysSince,
            user_sent_last: td.userSentLast,
          },
        };

        insertKnowledge(db, item);
        extracted++;
      } catch (err: any) {
        failed++;
      }
    }));

    process.stdout.write(`\r  Extracted: ${extracted}/${threadsToExtract.length} (${failed} failed)`);
  }

  console.log(`\n\nDone: ${extracted} sent emails ingested, ${failed} failed, ${corrected} inbox items corrected\n`);

  // Update sync state
  db.prepare(
    `INSERT OR REPLACE INTO sync_state (source, last_sync_at, items_synced, status, updated_at)
     VALUES ('gmail-sent-mass-ingest', datetime('now'), ?, 'complete', datetime('now'))`
  ).run(extracted);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
