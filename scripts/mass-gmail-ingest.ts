/**
 * Mass Gmail Ingestion — 14 months of email history
 *
 * Runs with high concurrency DeepSeek extraction (100 parallel agents)
 * One-time use to backfill historical email data.
 *
 * Usage: cd ~/GitHub/prime && npx tsx scripts/mass-gmail-ingest.ts
 */

import { getDb, getConfig, setConfig, insertKnowledge, type KnowledgeItem } from '../src/db.js';
import { generateEmbedding, generateEmbeddings } from '../src/embedding.js';
import { extractIntelligenceV2, toV1 } from '../src/ai/extract.js';
import { google } from 'googleapis';
import { v4 as uuid } from 'uuid';

const db = getDb();
const DAYS = 425; // ~14 months
const MAX_THREADS = 10000;
const EXTRACTION_CONCURRENCY = 100; // DeepSeek swarm

const CLIENT_ID = getConfig(db, 'google_client_id') || process.env.GOOGLE_CLIENT_ID || '';
const CLIENT_SECRET = getConfig(db, 'google_client_secret') || process.env.GOOGLE_CLIENT_SECRET || '';
const REDIRECT_URI = 'http://localhost:3210/auth/google/callback';

async function main() {
  console.log(`\n📧 MASS GMAIL INGESTION — ${DAYS} days, up to ${MAX_THREADS} threads, ${EXTRACTION_CONCURRENCY} concurrent agents\n`);

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

  // ── Phase 1: Fetch ALL thread IDs ──
  console.log(`Phase 1: Fetching threads since ${afterDate.toISOString().slice(0, 10)}...`);
  const allThreads: { id: string }[] = [];
  let pageToken: string | undefined;

  while (allThreads.length < MAX_THREADS) {
    const response = await gmail.users.threads.list({
      userId: 'me',
      maxResults: 500,
      q: `after:${afterEpoch}`,
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
  console.log(`\n  Total: ${allThreads.length} threads\n`);

  // ── Phase 2: Filter out already-indexed threads ──
  const existingRefs = new Set<string>();
  const existing = db.prepare("SELECT source_ref FROM knowledge WHERE source IN ('gmail', 'gmail-sent')").all() as any[];
  for (const e of existing) existingRefs.add(e.source_ref);

  const newThreads = allThreads.filter(t => !existingRefs.has(`thread:${t.id}`));
  console.log(`Phase 2: ${newThreads.length} new threads (${allThreads.length - newThreads.length} already indexed)\n`);

  if (newThreads.length === 0) {
    console.log('Nothing to ingest!');
    return;
  }

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

        return {
          id: t.id,
          subject: getHeader(first, 'Subject'),
          from: getHeader(first, 'From'),
          to: getHeader(first, 'To'),
          date: getHeader(last, 'Date'),
          snippet: last.snippet || '',
          messageCount: messages.length,
          body,
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

  // ── Phase 4: AI extraction with DeepSeek swarm (100 concurrent) ──
  console.log(`Phase 4: AI extraction (${EXTRACTION_CONCURRENCY} concurrent DeepSeek agents)...`);

  let extracted = 0;
  let failed = 0;

  for (let i = 0; i < threadData.length; i += EXTRACTION_CONCURRENCY) {
    const batch = threadData.slice(i, i + EXTRACTION_CONCURRENCY);

    await Promise.all(batch.map(async (td) => {
      try {
        const content = `Email thread: "${td.subject}"\nFrom: ${td.from}\nTo: ${td.to}\nDate: ${td.date}\nMessages: ${td.messageCount}\n\n${td.body}`;

        const result = await extractIntelligenceV2(content, {
          source: td.from.toLowerCase().includes(userEmail.toLowerCase()) ? 'gmail-sent' : 'gmail',
          apiKey: getConfig(db, 'openai_api_key'),
        });
        const v1 = toV1(result);

        const embedding = await generateEmbedding(`${v1.title} ${v1.summary}`);

        const item: KnowledgeItem = {
          id: uuid(),
          title: v1.title || `Email: ${td.subject}`,
          summary: v1.summary || td.snippet,
          source: td.from.toLowerCase().includes(userEmail.toLowerCase()) ? 'gmail-sent' : 'gmail',
          source_ref: `thread:${td.id}`,
          source_date: td.date ? new Date(td.date).toISOString() : new Date().toISOString(),
          contacts: v1.contacts || [],
          commitments: v1.commitments || [],
          embedding,
          importance: v1.importance || 'normal',
          project: v1.project || null,
          tags: v1.tags || [],
          metadata: {
            from: td.from,
            to: td.to,
            subject: td.subject,
            message_count: td.messageCount,
            raw_body_length: td.body.length,
          },
        };

        insertKnowledge(db, item);
        extracted++;
      } catch (err: any) {
        failed++;
      }
    }));

    process.stdout.write(`\r  Extracted: ${extracted}/${threadData.length} (${failed} failed)`);
  }

  console.log(`\n\nDone: ${extracted} emails ingested, ${failed} failed\n`);

  // Update sync state
  db.prepare(
    `INSERT OR REPLACE INTO sync_state (source, last_sync_at, items_synced, status, updated_at)
     VALUES ('gmail-mass-ingest', datetime('now'), ?, 'complete', datetime('now'))`
  ).run(extracted);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
