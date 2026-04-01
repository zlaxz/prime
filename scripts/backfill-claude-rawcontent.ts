/**
 * Backfill raw_content for Claude.ai conversations
 *
 * Fetches full conversation text from Claude.ai API for all
 * knowledge items with source='claude' that have no raw_content.
 * Stores the complete message text so FTS5 and prime_retrieve work.
 *
 * Usage: cd ~/GitHub/prime && npx tsx scripts/backfill-claude-rawcontent.ts
 */

import { getDb, getConfig } from '../src/db.js';
import { claudeApiGet } from '../src/connectors/claude.js';

const db = getDb();
const CONCURRENCY = 10; // API rate limiting

async function main() {
  const sessionKey = getConfig(db, 'claude_session_key');
  if (!sessionKey) {
    console.error('No claude_session_key configured');
    process.exit(1);
  }

  const orgs = getConfig(db, 'claude_organizations') || [];
  if (orgs.length === 0) {
    console.error('No claude_organizations configured');
    process.exit(1);
  }

  // Find items missing raw_content
  const items = db.prepare(`
    SELECT id, source_ref, title FROM knowledge
    WHERE source = 'claude'
    AND (raw_content IS NULL OR length(raw_content) < 10)
    AND source_ref LIKE 'claude:%'
    ORDER BY source_date DESC
  `).all() as any[];

  console.log(`\n📖 CLAUDE CONVERSATION RAW CONTENT BACKFILL\n`);
  console.log(`Found ${items.length} items missing raw_content`);
  console.log(`Orgs: ${orgs.map((o: any) => o.name).join(', ')}`);
  console.log(`Concurrency: ${CONCURRENCY}\n`);

  if (items.length === 0) {
    console.log('Nothing to backfill!');
    return;
  }

  let fetched = 0;
  let failed = 0;
  let skipped = 0;

  for (let i = 0; i < items.length; i += CONCURRENCY) {
    const batch = items.slice(i, i + CONCURRENCY);

    await Promise.all(batch.map(async (item: any) => {
      try {
        // Extract UUID from source_ref (format: claude:{uuid} or claude-artifact:{uuid}:{artifactId})
        const ref = item.source_ref;
        const uuid = ref.replace('claude:', '').split(':')[0];
        if (!uuid || uuid.length < 30) {
          skipped++;
          return;
        }

        // Try each org until we find the conversation
        let convoText = '';
        for (const org of orgs) {
          try {
            const convo = await claudeApiGet<any>(
              `/organizations/${org.uuid}/chat_conversations/${uuid}`,
              sessionKey,
              db
            );
            if (convo?.chat_messages?.length) {
              // Build full conversation text
              const parts = convo.chat_messages.map((msg: any) => {
                const sender = msg.sender || 'unknown';
                let text = '';
                if (typeof msg.text === 'string') {
                  text = msg.text;
                } else if (Array.isArray(msg.text)) {
                  text = msg.text
                    .map((t: any) => t.text || t.content || '')
                    .filter(Boolean)
                    .join('\n');
                }
                return `[${sender}] ${text}`;
              });
              convoText = parts.join('\n\n---\n\n');
              break;
            }
          } catch {}
        }

        if (convoText.length > 10) {
          db.prepare('UPDATE knowledge SET raw_content = ? WHERE id = ?')
            .run(convoText, item.id);
          fetched++;
        } else {
          skipped++;
        }
      } catch {
        failed++;
      }
    }));

    process.stdout.write(`\r  Progress: ${Math.min(i + CONCURRENCY, items.length)}/${items.length} (${fetched} fetched, ${failed} failed, ${skipped} skipped)`);

    // Rate limit: small delay between batches
    if (i + CONCURRENCY < items.length) {
      await new Promise(r => setTimeout(r, 500));
    }
  }

  console.log(`\n\nDone: ${fetched} conversations backfilled, ${failed} failed, ${skipped} skipped`);
  console.log(`Total raw_content items: ${db.prepare("SELECT COUNT(*) as c FROM knowledge WHERE raw_content IS NOT NULL AND length(raw_content) > 10").get()?.c}`);
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
