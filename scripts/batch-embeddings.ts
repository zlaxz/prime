/**
 * Batch Embedding Generator — backfill embeddings for all knowledge items
 *
 * Finds all items where embedding is NULL or empty, generates embeddings
 * in batches of 50 using OpenAI text-embedding-3-small via generateEmbeddings().
 *
 * Usage: cd ~/GitHub/prime && npx tsx scripts/batch-embeddings.ts
 */

import { getDb, getConfig } from '../src/db.js';
import { generateEmbeddings, resolveEmbeddingConfig } from '../src/embedding.js';

const db = getDb();
const BATCH_SIZE = 50;

async function main() {
  console.log('\n--- BATCH EMBEDDING GENERATOR ---\n');

  // Resolve embedding config from DB
  const openaiKey = getConfig(db, 'openai_api_key');
  const embeddingProvider = getConfig(db, 'embedding_provider') as string | undefined;
  const ollamaUrl = getConfig(db, 'ollama_url') as string | undefined;
  const embeddingModel = getConfig(db, 'embedding_model') as string | undefined;

  const embConfig = resolveEmbeddingConfig({
    openai_api_key: openaiKey,
    embedding_provider: embeddingProvider,
    ollama_url: ollamaUrl,
    embedding_model: embeddingModel,
  });

  console.log(`Provider: ${embConfig.provider}`);
  console.log(`Model: ${embConfig.model || '(default)'}`);

  if (embConfig.provider === 'openai' && !embConfig.apiKey) {
    console.error('No OpenAI API key found. Set openai_api_key in config table or OPENAI_API_KEY env var.');
    process.exit(1);
  }

  // Find all items with NULL or empty embedding
  // SQLite stores embeddings as BLOB — NULL means never set, zero-length means empty array was stored
  const items = db.prepare(`
    SELECT id, title, summary, contacts, tags
    FROM knowledge
    WHERE embedding IS NULL OR length(embedding) = 0
    ORDER BY source_date DESC
  `).all() as { id: string; title: string; summary: string; contacts: string; tags: string }[];

  console.log(`Found ${items.length} items missing embeddings\n`);

  if (items.length === 0) {
    console.log('Nothing to do!');
    return;
  }

  // Prepare the update statement
  const updateStmt = db.prepare(
    "UPDATE knowledge SET embedding = ?, updated_at = datetime('now') WHERE id = ?"
  );

  let processed = 0;
  let failed = 0;

  for (let i = 0; i < items.length; i += BATCH_SIZE) {
    const batch = items.slice(i, i + BATCH_SIZE);

    // Build embedding text for each item: title + summary + contacts + tags
    const texts = batch.map(item => {
      const contacts = typeof item.contacts === 'string'
        ? (() => { try { return JSON.parse(item.contacts); } catch { return []; } })()
        : (item.contacts || []);
      const tags = typeof item.tags === 'string'
        ? (() => { try { return JSON.parse(item.tags); } catch { return []; } })()
        : (item.tags || []);

      return [
        item.title,
        item.summary,
        Array.isArray(contacts) ? contacts.join(', ') : '',
        Array.isArray(tags) ? tags.join(', ') : '',
      ].filter(Boolean).join('\n').slice(0, 8000);
    });

    try {
      const embeddings = await generateEmbeddings(texts, embConfig);

      // Update each item with its embedding
      const txn = db.transaction(() => {
        for (let j = 0; j < batch.length; j++) {
          const embedding = embeddings[j];
          if (embedding && embedding.length > 0) {
            const blob = Buffer.from(new Float32Array(embedding).buffer);
            updateStmt.run(blob, batch[j].id);
            processed++;
          } else {
            failed++;
          }
        }
      });
      txn();
    } catch (err: any) {
      console.error(`\n  Batch ${Math.floor(i / BATCH_SIZE) + 1} failed: ${err.message}`);
      failed += batch.length;
    }

    process.stdout.write(`\r  Progress: ${Math.min(i + BATCH_SIZE, items.length)}/${items.length} (${processed} embedded, ${failed} failed)`);

    // Small delay between batches to avoid rate limits
    if (i + BATCH_SIZE < items.length) {
      await new Promise(r => setTimeout(r, 200));
    }
  }

  console.log(`\n\nDone: ${processed} embeddings generated, ${failed} failed\n`);

  // Show remaining count
  const remaining = db.prepare(
    'SELECT count(*) as cnt FROM knowledge WHERE embedding IS NULL OR length(embedding) = 0'
  ).get() as { cnt: number };
  console.log(`Remaining without embeddings: ${remaining.cnt}`);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
