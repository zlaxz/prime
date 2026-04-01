/**
 * Chunk Embedding Backfill — split long knowledge items into overlapping chunks with embeddings
 *
 * Finds all knowledge items where raw_content > 5000 chars,
 * splits into 4000-char chunks with 500-char overlap, and embeds each chunk.
 * Processes in batches of 10 to manage API rate limits.
 *
 * Usage: cd ~/GitHub/prime && npx tsx scripts/chunk-embeddings.ts
 */

import { getDb, getConfig } from '../src/db.js';
import { chunkAndEmbed, resolveEmbeddingConfig } from '../src/embedding.js';

const db = getDb();
const BATCH_SIZE = 10;

async function main() {
  console.log('\n--- CHUNK EMBEDDING BACKFILL ---\n');

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

  // Find all knowledge items with long raw_content that haven't been chunked yet
  const items = db.prepare(`
    SELECT k.id, k.title, k.raw_content, length(k.raw_content) as content_length
    FROM knowledge k
    WHERE k.raw_content IS NOT NULL
      AND length(k.raw_content) > 5000
      AND k.id NOT IN (SELECT DISTINCT knowledge_id FROM knowledge_chunks)
    ORDER BY length(k.raw_content) DESC
  `).all() as { id: string; title: string; raw_content: string; content_length: number }[];

  console.log(`Found ${items.length} knowledge items with raw_content > 5000 chars needing chunks\n`);

  if (items.length === 0) {
    // Show stats on existing chunks
    const existingChunks = db.prepare('SELECT COUNT(*) as cnt FROM knowledge_chunks').get() as { cnt: number };
    const chunkedItems = db.prepare('SELECT COUNT(DISTINCT knowledge_id) as cnt FROM knowledge_chunks').get() as { cnt: number };
    console.log(`Existing chunks: ${existingChunks.cnt} across ${chunkedItems.cnt} knowledge items`);
    console.log('Nothing to do!');
    return;
  }

  let processed = 0;
  let totalChunks = 0;
  let failed = 0;

  for (let i = 0; i < items.length; i += BATCH_SIZE) {
    const batch = items.slice(i, i + BATCH_SIZE);

    for (const item of batch) {
      try {
        const chunks = await chunkAndEmbed(
          db,
          item.id,
          item.raw_content,
          embConfig,
          4000,  // chunkSize
          500,   // overlap
        );
        processed++;
        totalChunks += chunks;
        process.stdout.write(
          `\r  Progress: ${processed + failed}/${items.length} | ` +
          `${processed} items chunked (${totalChunks} chunks total), ${failed} failed`
        );
      } catch (err: any) {
        console.error(`\n  Failed: ${item.title} (${item.content_length} chars): ${err.message}`);
        failed++;
      }
    }

    // Delay between batches to avoid rate limits
    if (i + BATCH_SIZE < items.length) {
      await new Promise(r => setTimeout(r, 500));
    }
  }

  console.log(`\n\nDone: ${processed} items chunked into ${totalChunks} total chunks, ${failed} failed\n`);

  // Show summary stats
  const totalChunksInDb = db.prepare('SELECT COUNT(*) as cnt FROM knowledge_chunks').get() as { cnt: number };
  const chunkedItemsInDb = db.prepare('SELECT COUNT(DISTINCT knowledge_id) as cnt FROM knowledge_chunks').get() as { cnt: number };
  const embeddedChunks = db.prepare('SELECT COUNT(*) as cnt FROM knowledge_chunks WHERE embedding IS NOT NULL').get() as { cnt: number };
  console.log(`Total chunks in DB: ${totalChunksInDb.cnt} across ${chunkedItemsInDb.cnt} knowledge items`);
  console.log(`Chunks with embeddings: ${embeddedChunks.cnt}`);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
