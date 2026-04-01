import type Database from 'better-sqlite3';
import {
  searchByText,
  searchByEmbedding,
  searchByFTS,
  getConfig,
  getThemes,
  getSemantics,
  cosineSimilarity,
} from '../db.js';
import { generateEmbedding } from '../embedding.js';
import { getDefaultProvider, type LLMProvider } from './providers.js';

// ============================================================
// Types
// ============================================================

export interface SearchOptions {
  limit?: number;           // default 15
  strategy?: 'auto' | 'semantic' | 'keyword' | 'graph' | 'temporal' | 'hierarchical' | 'fts' | 'entity';
  project?: string;
  source?: string;
  since?: string;           // ISO date — only items after this
  rerank?: boolean;         // default true — Claude reranks results
  recencyBias?: number;     // default 0.05 — higher = more recency preference
                            // weight = 1 / (1 + days_old * recencyBias)
                            // 0.05: today=1.0, 7d=0.74, 30d=0.40, 90d=0.18
                            // 0.10: today=1.0, 7d=0.59, 30d=0.25, 90d=0.10
                            // 0.00: disabled (pure relevance, no recency boost)
  graphDepth?: number;      // default 2 (entity + 1 hop). Set to 3 for a second hop.
  similar_to?: string;      // knowledge item ID — use its embedding as query vector
}

export interface SearchResult {
  items: any[];             // knowledge items with scores
  strategy_used: string;
  confidence: number;       // 0-1 overall confidence
  coverage: {
    sources_found: number;
    recency: 'fresh' | 'mixed' | 'stale';
    agreement: 'consistent' | 'mixed' | 'conflicting';
  };
}

// ============================================================
// BM25 scoring
// ============================================================

function bm25Score(query: string, document: string, avgDocLength: number, k1 = 1.5, b = 0.75): number {
  const queryTerms = query.toLowerCase().split(/\s+/).filter(Boolean);
  const docTerms = document.toLowerCase().split(/\s+/);
  const docLength = docTerms.length;
  const termFreqs = new Map<string, number>();
  for (const t of docTerms) termFreqs.set(t, (termFreqs.get(t) || 0) + 1);

  let score = 0;
  for (const term of queryTerms) {
    const tf = termFreqs.get(term) || 0;
    if (tf === 0) continue;
    const numerator = tf * (k1 + 1);
    const denominator = tf + k1 * (1 - b + b * (docLength / avgDocLength));
    score += numerator / denominator;
  }
  return score;
}

// ============================================================
// Helpers
// ============================================================

function decodeEmbedding(blob: any): number[] | null {
  if (!blob) return null;
  if (Buffer.isBuffer(blob) || blob instanceof Uint8Array) {
    const floats = new Float32Array(blob.buffer, blob.byteOffset, blob.byteLength / 4);
    return Array.from(floats);
  }
  return null;
}

/**
 * Search knowledge_chunks by embedding similarity.
 * Returns parent knowledge_id and the best chunk similarity score per knowledge item.
 */
function searchChunksByEmbedding(
  db: Database.Database,
  queryEmbedding: number[],
  limit: number,
  threshold: number,
): Map<string, number> {
  const chunks = db.prepare(
    'SELECT knowledge_id, embedding FROM knowledge_chunks WHERE embedding IS NOT NULL'
  ).all() as { knowledge_id: string; embedding: any }[];

  // Track best similarity per knowledge_id
  const bestScores = new Map<string, number>();

  for (const chunk of chunks) {
    const emb = decodeEmbedding(chunk.embedding);
    if (!emb) continue;
    const sim = cosineSimilarity(queryEmbedding, emb);
    if (sim < threshold) continue;
    const existing = bestScores.get(chunk.knowledge_id) || 0;
    if (sim > existing) {
      bestScores.set(chunk.knowledge_id, sim);
    }
  }

  // Sort by score descending and take top N
  const sorted = Array.from(bestScores.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit);

  return new Map(sorted);
}

function parseJsonField(val: any): any[] {
  if (Array.isArray(val)) return val;
  if (typeof val === 'string') {
    try { return JSON.parse(val); } catch { return []; }
  }
  return [];
}

function parseJsonFields(row: any): any {
  for (const field of ['contacts', 'organizations', 'decisions', 'commitments', 'action_items', 'tags', 'metadata']) {
    if (row[field] && typeof row[field] === 'string') {
      try { row[field] = JSON.parse(row[field]); } catch {}
    }
  }
  return row;
}

function deduplicateById(items: any[]): any[] {
  const seen = new Set<string>();
  const result: any[] = [];
  for (const item of items) {
    if (!seen.has(item.id)) {
      seen.add(item.id);
      result.push(item);
    }
  }
  return result;
}

/** Deduplicate by source_ref — keep the highest-scoring item per source_ref. */
function deduplicateBySourceRef(items: any[]): any[] {
  const bestByRef = new Map<string, any>();
  for (const item of items) {
    const ref = item.source_ref;
    if (!ref) {
      // No source_ref — keep as-is (keyed by id to avoid duplicates)
      bestByRef.set(item.id, item);
      continue;
    }
    const existing = bestByRef.get(ref);
    if (!existing || (item._score || 0) > (existing._score || 0)) {
      bestByRef.set(ref, item);
    }
  }
  return Array.from(bestByRef.values());
}

// ============================================================
// Recency weighting
// ============================================================

/**
 * Compute a recency multiplier for a given item date.
 * Formula: 1 / (1 + days_old * bias)
 *
 * With default bias=0.05:
 *   today → 1.00, 1d → 0.95, 7d → 0.74, 30d → 0.40, 90d → 0.18
 */
function computeRecencyWeight(sourceDate: string | null | undefined, bias: number): number {
  if (bias <= 0 || !sourceDate) return 1.0;
  const itemTime = new Date(sourceDate).getTime();
  if (isNaN(itemTime)) return 1.0;
  const daysOld = Math.max(0, (Date.now() - itemTime) / 86400000);
  return 1 / (1 + daysOld * bias);
}

/** Apply recency weighting to an array of scored items in-place and return them. */
function applyRecencyWeighting(items: any[], bias: number): any[] {
  if (bias <= 0) return items;
  for (const item of items) {
    const weight = computeRecencyWeight(item.source_date, bias);
    item._recency_weight = weight;
    item._score = (item._score || 0) * weight;
  }
  return items;
}

// ============================================================
// Temporal helpers
// ============================================================

const TEMPORAL_WORDS = [
  'today', 'yesterday', 'this week', 'last week', 'this month', 'last month',
  'recently', 'recent', 'latest', 'new', 'changed', 'updated', 'what happened',
  'catch up', 'catch me up',
];

function hasTemporalIntent(query: string): boolean {
  const q = query.toLowerCase();
  return TEMPORAL_WORDS.some(w => q.includes(w));
}

function getTemporalRange(query: string): { since: string; label: string } {
  const q = query.toLowerCase();
  const now = new Date();

  if (q.includes('today')) {
    const d = new Date(now); d.setHours(0, 0, 0, 0);
    return { since: d.toISOString(), label: 'today' };
  }
  if (q.includes('yesterday')) {
    const d = new Date(now); d.setDate(d.getDate() - 1); d.setHours(0, 0, 0, 0);
    return { since: d.toISOString(), label: 'yesterday' };
  }
  if (q.includes('this week')) {
    const d = new Date(now); d.setDate(d.getDate() - d.getDay()); d.setHours(0, 0, 0, 0);
    return { since: d.toISOString(), label: 'this week' };
  }
  if (q.includes('last week')) {
    const d = new Date(now); d.setDate(d.getDate() - d.getDay() - 7); d.setHours(0, 0, 0, 0);
    return { since: d.toISOString(), label: 'last week' };
  }
  if (q.includes('this month')) {
    const d = new Date(now.getFullYear(), now.getMonth(), 1);
    return { since: d.toISOString(), label: 'this month' };
  }
  if (q.includes('last month')) {
    const d = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    return { since: d.toISOString(), label: 'last month' };
  }
  // Default: last 7 days for "recently", "latest", etc.
  const d = new Date(now); d.setDate(d.getDate() - 7);
  return { since: d.toISOString(), label: 'last 7 days' };
}

function findContactInQuery(query: string, db: Database.Database): string | null {
  // Get all unique contacts from knowledge base
  const rows = db.prepare(
    "SELECT DISTINCT contacts FROM knowledge_primary WHERE contacts IS NOT NULL AND contacts != '[]'"
  ).all() as any[];

  const allContacts = new Set<string>();
  for (const row of rows) {
    const contacts = parseJsonField(row.contacts);
    for (const c of contacts) allContacts.add(c);
  }

  const qLower = query.toLowerCase();
  for (const contact of allContacts) {
    if (qLower.includes(contact.toLowerCase())) return contact;
  }
  return null;
}

// ============================================================
// Strategy implementations
// ============================================================

async function semanticSearch(
  db: Database.Database,
  query: string,
  limit: number,
  apiKey: string,
  recencyBias: number = 0.05,
  since?: string,
): Promise<any[]> {
  const queryEmb = await generateEmbedding(query, apiKey);
  // Fetch extra results to account for since-filtering
  const fetchLimit = since ? limit * 2 : limit;
  const results = searchByEmbedding(db, queryEmb, fetchLimit, 0.2);

  // Also search knowledge_chunks for finer-grained matches
  const chunkScores = searchChunksByEmbedding(db, queryEmb, fetchLimit, 0.2);

  // Build a map of knowledge_id -> best score from direct embedding search
  const directScores = new Map<string, { item: any; score: number }>();
  for (const r of results) {
    directScores.set(r.id, { item: r, score: r.similarity || 0 });
  }

  // Merge chunk results: if a chunk matched a knowledge_id not already in results,
  // fetch the parent knowledge item. If already present, use the HIGHER score.
  for (const [knowledgeId, chunkScore] of chunkScores) {
    const existing = directScores.get(knowledgeId);
    if (existing) {
      // Use the higher of direct vs chunk score
      if (chunkScore > existing.score) {
        existing.score = chunkScore;
        existing.item.similarity = chunkScore;
        existing.item._chunk_boosted = true;
      }
    } else {
      // Chunk matched but parent wasn't in direct results — fetch the parent item
      const parent = db.prepare(
        'SELECT * FROM knowledge WHERE id = ?'
      ).get(knowledgeId) as any;
      if (parent) {
        parent.similarity = chunkScore;
        parent.embedding = null; // Don't carry blob
        parent._chunk_boosted = true;
        // Parse JSON fields
        for (const field of ['contacts', 'organizations', 'decisions', 'commitments', 'action_items', 'tags', 'metadata']) {
          if (parent[field] && typeof parent[field] === 'string') {
            try { parent[field] = JSON.parse(parent[field]); } catch {}
          }
        }
        directScores.set(knowledgeId, { item: parent, score: chunkScore });
      }
    }
  }

  // Reassemble into scored array
  let merged = Array.from(directScores.values()).map(({ item, score }) => ({
    ...item,
    _score: score,
    _strategy: 'semantic',
  }));

  if (since) {
    merged = merged.filter(r => r.source_date && r.source_date >= since);
  }

  return applyRecencyWeighting(merged, recencyBias)
    .sort((a: any, b: any) => b._score - a._score)
    .slice(0, limit);
}

function keywordSearch(
  db: Database.Database,
  query: string,
  limit: number,
  recencyBias: number = 0.05,
  since?: string,
): any[] {
  // Get all knowledge items for BM25 scoring, optionally filtered by date
  let items: any[];
  if (since) {
    items = db.prepare('SELECT * FROM knowledge_primary WHERE source_date >= ?').all(since) as any[];
  } else {
    items = db.prepare('SELECT * FROM knowledge_primary').all() as any[];
  }
  if (items.length === 0) return [];

  // Compute average document length (matches fullDoc construction below)
  const avgDocLength = items.reduce((sum, item) => {
    const doc = `${item.title || ''} ${item.summary || ''} ${item.contacts || ''} ${item.tags || ''} ${item.raw_content || ''} ${typeof item.metadata === 'string' ? item.metadata : JSON.stringify(item.metadata || {})}`;
    return sum + doc.split(/\s+/).length;
  }, 0) / items.length;

  const queryTerms = query.toLowerCase().split(/\s+/).filter(Boolean);

  const scored = items.map(item => {
    parseJsonFields(item);

    const titleDoc = (item.title || '').toLowerCase();
    const summaryDoc = (item.summary || '').toLowerCase();
    const contactsDoc = (Array.isArray(item.contacts) ? item.contacts.join(' ') : '').toLowerCase();
    const tagsDoc = (Array.isArray(item.tags) ? item.tags.join(' ') : '').toLowerCase();
    const rawContentDoc = (item.raw_content || '').toLowerCase();
    const metadataDoc = (typeof item.metadata === 'string' ? item.metadata : JSON.stringify(item.metadata || {})).toLowerCase();

    // BM25 on full document (includes raw_content and metadata for contact/body matches)
    const fullDoc = `${item.title || ''} ${item.summary || ''} ${contactsDoc} ${tagsDoc} ${rawContentDoc} ${metadataDoc}`;
    let score = bm25Score(query, fullDoc, avgDocLength);

    // Boost title matches 3x
    const titleMatches = queryTerms.filter(t => titleDoc.includes(t)).length;
    score += titleMatches * 3.0;

    // Boost contact matches 2x
    const contactMatches = queryTerms.filter(t => contactsDoc.includes(t)).length;
    score += contactMatches * 2.0;

    // Boost tag matches 1.5x
    const tagMatches = queryTerms.filter(t => tagsDoc.includes(t)).length;
    score += tagMatches * 1.5;

    // Boost raw_content matches 1x (body text, From/To headers)
    const rawContentMatches = queryTerms.filter(t => rawContentDoc.includes(t)).length;
    score += rawContentMatches * 1.0;

    item.embedding = null; // Don't carry blob data
    return { ...item, _score: score, _strategy: 'keyword' };
  })
  .filter(item => item._score > 0);

  // Apply recency weighting before final sort
  applyRecencyWeighting(scored, recencyBias);

  return scored
    .sort((a, b) => b._score - a._score)
    .slice(0, limit);
}

// ============================================================
// Graph traversal — entity graph search
// ============================================================

/**
 * Match entities from the query string using canonical names and aliases.
 * Returns entity IDs that appear in the query text (case-insensitive).
 * Pure SQL — no LLM calls.
 */
function matchEntitiesFromQuery(db: Database.Database, query: string): { id: string; name: string }[] {
  const qLower = query.toLowerCase();

  // Fetch all entities with their canonical names
  const entities = db.prepare(
    `SELECT id, canonical_name FROM entities WHERE user_dismissed = 0`
  ).all() as { id: string; canonical_name: string }[];

  const matched = new Map<string, string>();

  const queryTerms = qLower.split(/\s+/).filter(Boolean);

  // Match against canonical names (multi-word names matched first for specificity)
  const sorted = entities.slice().sort((a, b) => b.canonical_name.length - a.canonical_name.length);
  for (const e of sorted) {
    const nameLower = e.canonical_name.toLowerCase();
    // Full name match (query contains "dan gilhooly")
    if (qLower.includes(nameLower)) {
      matched.set(e.id, e.canonical_name);
      continue;
    }
    // Partial match: any individual name part matches a query term (e.g., "gilhooly" matches "Dan Gilhooly")
    const nameParts = nameLower.split(/\s+/).filter(p => p.length >= 3); // skip short parts like "al", "de"
    for (const part of nameParts) {
      if (queryTerms.includes(part)) {
        matched.set(e.id, e.canonical_name);
        break;
      }
    }
  }

  // Match against aliases
  const aliases = db.prepare(
    `SELECT ea.entity_id, ea.alias, e.canonical_name
     FROM entity_aliases ea
     JOIN entities e ON e.id = ea.entity_id
     WHERE e.user_dismissed = 0`
  ).all() as { entity_id: string; alias: string; canonical_name: string }[];

  const sortedAliases = aliases.slice().sort((a, b) => b.alias.length - a.alias.length);
  for (const a of sortedAliases) {
    if (matched.has(a.entity_id)) continue;
    const aliasLower = a.alias.toLowerCase();
    // Full alias match
    if (qLower.includes(aliasLower)) {
      matched.set(a.entity_id, a.canonical_name);
      continue;
    }
    // Partial alias match: individual parts
    const aliasParts = aliasLower.split(/\s+/).filter(p => p.length >= 3);
    for (const part of aliasParts) {
      if (queryTerms.includes(part)) {
        matched.set(a.entity_id, a.canonical_name);
        break;
      }
    }
  }

  return Array.from(matched.entries()).map(([id, name]) => ({ id, name }));
}

/**
 * Graph traversal search: follows entity relationships through the entity graph.
 *
 * SEED:   Extract entity names from query via matchEntitiesFromQuery
 * HOP 1:  Find all knowledge items mentioning those entities (entity_mentions)
 * HOP 2:  Find connected entities (entity_edges, ordered by co_occurrence_count)
 * HOP 3:  Find knowledge items for connected entities
 * THREAD: If items belong to narrative_threads, pull thread siblings
 * SCORE:  Direct=0.9, Connected=0.6*(co_occ/max_co_occ), Thread=+0.15
 *
 * All SQL, no LLM calls. Target: <100ms on local SQLite.
 */
function graphTraversalSearch(
  db: Database.Database,
  query: string,
  limit: number,
  recencyBias: number = 0.05,
  graphDepth: number = 2,
  since?: string,
): any[] {
  // ── SEED: extract entities from query ──────────────────────
  const seedEntities = matchEntitiesFromQuery(db, query);
  if (seedEntities.length === 0) return [];

  const seedEntityIds = seedEntities.map(e => e.id);
  const itemScores = new Map<string, { score: number; via: string }>();

  // ── HOP 1: knowledge items directly mentioning seed entities ──
  if (seedEntityIds.length > 0) {
    const ph = seedEntityIds.map(() => '?').join(',');
    const directMentions = db.prepare(
      `SELECT DISTINCT em.knowledge_item_id
       FROM entity_mentions em
       WHERE em.entity_id IN (${ph})`
    ).all(...seedEntityIds) as { knowledge_item_id: string }[];

    for (const m of directMentions) {
      itemScores.set(m.knowledge_item_id, {
        score: 0.9,
        via: `direct mention of ${seedEntities.map(e => e.name).join(', ')}`,
      });
    }
  }

  // ── HOP 2: connected entities via entity_edges ─────────────
  let connectedEntities: { id: string; name: string; coOccurrence: number }[] = [];
  let maxCoOccurrence = 1;

  if (graphDepth >= 2 && seedEntityIds.length > 0) {
    const ph = seedEntityIds.map(() => '?').join(',');
    const edges = db.prepare(
      `SELECT ee.source_entity_id, ee.target_entity_id, ee.co_occurrence_count,
              e1.canonical_name AS source_name, e2.canonical_name AS target_name
       FROM entity_edges ee
       JOIN entities e1 ON e1.id = ee.source_entity_id
       JOIN entities e2 ON e2.id = ee.target_entity_id
       WHERE (ee.source_entity_id IN (${ph}) OR ee.target_entity_id IN (${ph}))
         AND ee.user_denied = 0
         AND ee.invalid_at IS NULL
       ORDER BY ee.co_occurrence_count DESC
       LIMIT 30`
    ).all(...seedEntityIds, ...seedEntityIds) as {
      source_entity_id: string; target_entity_id: string; co_occurrence_count: number;
      source_name: string; target_name: string;
    }[];

    const seedSet = new Set(seedEntityIds);
    const seen = new Set<string>();

    for (const edge of edges) {
      const connId = seedSet.has(edge.source_entity_id) ? edge.target_entity_id : edge.source_entity_id;
      const connName = seedSet.has(edge.source_entity_id) ? edge.target_name : edge.source_name;
      if (seedSet.has(connId) || seen.has(connId)) continue;
      seen.add(connId);
      connectedEntities.push({ id: connId, name: connName, coOccurrence: edge.co_occurrence_count });
      if (edge.co_occurrence_count > maxCoOccurrence) maxCoOccurrence = edge.co_occurrence_count;
    }

    // HOP 2 items: knowledge items mentioning connected entities
    if (connectedEntities.length > 0) {
      const connIds = connectedEntities.map(c => c.id);
      const ph2 = connIds.map(() => '?').join(',');
      const connMentions = db.prepare(
        `SELECT DISTINCT em.knowledge_item_id, em.entity_id
         FROM entity_mentions em
         WHERE em.entity_id IN (${ph2})`
      ).all(...connIds) as { knowledge_item_id: string; entity_id: string }[];

      // Build a lookup for co_occurrence by entity id
      const coOccMap = new Map(connectedEntities.map(c => [c.id, c.coOccurrence]));
      const nameMap = new Map(connectedEntities.map(c => [c.id, c.name]));

      for (const m of connMentions) {
        const coOcc = coOccMap.get(m.entity_id) || 1;
        const hopScore = 0.6 * (coOcc / maxCoOccurrence);
        const existing = itemScores.get(m.knowledge_item_id);
        if (!existing || existing.score < hopScore) {
          // Don't downgrade a direct hit
          if (!existing) {
            itemScores.set(m.knowledge_item_id, {
              score: hopScore,
              via: `connected entity: ${nameMap.get(m.entity_id) || 'unknown'} (${coOcc} co-occurrences)`,
            });
          }
        }
      }
    }
  }

  // ── HOP 3 (optional): second degree connections ────────────
  if (graphDepth >= 3 && connectedEntities.length > 0) {
    const hop1Ids = connectedEntities.map(c => c.id);
    const ph = hop1Ids.map(() => '?').join(',');
    const allSeedAndHop1 = new Set([...seedEntityIds, ...hop1Ids]);

    const hop2Edges = db.prepare(
      `SELECT ee.source_entity_id, ee.target_entity_id, ee.co_occurrence_count,
              e1.canonical_name AS source_name, e2.canonical_name AS target_name
       FROM entity_edges ee
       JOIN entities e1 ON e1.id = ee.source_entity_id
       JOIN entities e2 ON e2.id = ee.target_entity_id
       WHERE (ee.source_entity_id IN (${ph}) OR ee.target_entity_id IN (${ph}))
         AND ee.user_denied = 0
         AND ee.invalid_at IS NULL
       ORDER BY ee.co_occurrence_count DESC
       LIMIT 20`
    ).all(...hop1Ids, ...hop1Ids) as {
      source_entity_id: string; target_entity_id: string; co_occurrence_count: number;
      source_name: string; target_name: string;
    }[];

    const hop2Entities: { id: string; name: string; coOccurrence: number }[] = [];
    const hop2Seen = new Set<string>();

    for (const edge of hop2Edges) {
      const hop1Set = new Set(hop1Ids);
      const connId = hop1Set.has(edge.source_entity_id) ? edge.target_entity_id : edge.source_entity_id;
      const connName = hop1Set.has(edge.source_entity_id) ? edge.target_name : edge.source_name;
      if (allSeedAndHop1.has(connId) || hop2Seen.has(connId)) continue;
      hop2Seen.add(connId);
      hop2Entities.push({ id: connId, name: connName, coOccurrence: edge.co_occurrence_count });
    }

    if (hop2Entities.length > 0) {
      const hop2Ids = hop2Entities.map(c => c.id);
      const ph2 = hop2Ids.map(() => '?').join(',');
      const hop2Mentions = db.prepare(
        `SELECT DISTINCT em.knowledge_item_id, em.entity_id
         FROM entity_mentions em
         WHERE em.entity_id IN (${ph2})`
      ).all(...hop2Ids) as { knowledge_item_id: string; entity_id: string }[];

      const coOccMap2 = new Map(hop2Entities.map(c => [c.id, c.coOccurrence]));
      const nameMap2 = new Map(hop2Entities.map(c => [c.id, c.name]));
      const maxCoOcc2 = Math.max(...hop2Entities.map(c => c.coOccurrence), 1);

      for (const m of hop2Mentions) {
        const coOcc = coOccMap2.get(m.entity_id) || 1;
        // 2nd hop scores lower: 0.3 base instead of 0.6
        const hopScore = 0.3 * (coOcc / maxCoOcc2);
        const existing = itemScores.get(m.knowledge_item_id);
        if (!existing) {
          itemScores.set(m.knowledge_item_id, {
            score: hopScore,
            via: `2nd-hop entity: ${nameMap2.get(m.entity_id) || 'unknown'}`,
          });
        }
      }
    }
  }

  if (itemScores.size === 0) return [];

  // ── THREAD EXPANSION: pull siblings from narrative threads ──
  const allItemIds = Array.from(itemScores.keys());
  const threadBoostIds = new Set<string>();

  if (allItemIds.length > 0) {
    // Find which threads these items belong to (batched)
    const batchSize = 400;
    const threadIds = new Set<string>();
    for (let i = 0; i < allItemIds.length; i += batchSize) {
      const batch = allItemIds.slice(i, i + batchSize);
      const ph = batch.map(() => '?').join(',');
      const rows = db.prepare(
        `SELECT DISTINCT thread_id FROM thread_items WHERE knowledge_item_id IN (${ph})`
      ).all(...batch) as { thread_id: string }[];
      for (const r of rows) threadIds.add(r.thread_id);
    }

    // Pull all items from those threads
    if (threadIds.size > 0) {
      const tph = Array.from(threadIds).map(() => '?').join(',');
      const threadItemRows = db.prepare(
        `SELECT knowledge_item_id, thread_id FROM thread_items WHERE thread_id IN (${tph})`
      ).all(...Array.from(threadIds)) as { knowledge_item_id: string; thread_id: string }[];

      for (const ti of threadItemRows) {
        threadBoostIds.add(ti.knowledge_item_id);
        const existing = itemScores.get(ti.knowledge_item_id);
        if (existing) {
          // Boost existing items that share a thread
          existing.score = Math.min(existing.score + 0.15, 1.0);
        } else {
          // New item discovered via thread — base score 0.4 + thread boost
          itemScores.set(ti.knowledge_item_id, {
            score: 0.4 + 0.15,
            via: `thread sibling (thread ${ti.thread_id})`,
          });
        }
      }
    }
  }

  // ── FETCH knowledge items and build results ────────────────
  const finalItemIds = Array.from(itemScores.keys());
  if (finalItemIds.length === 0) return [];

  const results: any[] = [];
  const batchSize = 400;
  for (let i = 0; i < finalItemIds.length; i += batchSize) {
    const batch = finalItemIds.slice(i, i + batchSize);
    const ph = batch.map(() => '?').join(',');
    const sinceClause = since ? ` AND source_date >= ?` : '';
    const queryParams = since ? [...batch, since] : batch;
    const rows = db.prepare(
      `SELECT * FROM knowledge_primary WHERE id IN (${ph})${sinceClause}`
    ).all(...queryParams) as any[];

    for (const row of rows) {
      parseJsonFields(row);
      row.embedding = null;
      const scoreInfo = itemScores.get(row.id)!;
      results.push({
        ...row,
        _score: scoreInfo.score,
        _strategy: 'graph',
        _via: scoreInfo.via,
        _thread_boost: threadBoostIds.has(row.id),
      });
    }
  }

  // Apply recency weighting
  applyRecencyWeighting(results, recencyBias);

  return results
    .sort((a, b) => b._score - a._score)
    .slice(0, limit);
}

// ============================================================
// FTS5 search — SQLite full-text search with BM25 ranking
// ============================================================

function ftsSearch(
  db: Database.Database,
  query: string,
  limit: number,
  recencyBias: number = 0.05,
  since?: string,
  source?: string,
  project?: string,
): any[] {
  const rawResults = searchByFTS(db, query, limit * 3);
  if (rawResults.length === 0) return [];

  // Filter by provenance (primary sources only) and optional filters
  let filtered = rawResults.filter(r => {
    const derivedSources = ['agent-report', 'agent-notification', 'briefing', 'directive', 'training'];
    if (derivedSources.includes(r.source)) return false;
    if (since && r.source_date && r.source_date < since) return false;
    if (source && r.source !== source) return false;
    if (project && r.project && !r.project.toLowerCase().includes(project.toLowerCase())) return false;
    return true;
  });

  // fts_rank from bm25() is negative (lower = better), so negate to get positive scores
  // Normalize so highest score = 1.0
  const maxRank = filtered.length > 0
    ? Math.max(...filtered.map(r => -(r.fts_rank || 0)))
    : 1;

  const scored = filtered.map(row => {
    row.embedding = null;
    const normScore = maxRank > 0 ? -(row.fts_rank || 0) / maxRank : 0;
    delete row.fts_rank;
    return { ...row, _score: normScore, _strategy: 'fts' };
  });

  applyRecencyWeighting(scored, recencyBias);

  return scored
    .sort((a, b) => b._score - a._score)
    .slice(0, limit);
}

// ============================================================
// Entity-scoped search — find ALL items mentioning a matched entity
// ============================================================

function entitySearch(
  db: Database.Database,
  query: string,
  limit: number,
  recencyBias: number = 0.05,
  since?: string,
): any[] {
  const matchedEntities = matchEntitiesFromQuery(db, query);
  if (matchedEntities.length === 0) return [];

  const entityIds = matchedEntities.map(e => e.id);
  const ph = entityIds.map(() => '?').join(',');

  // Find ALL knowledge items that mention these entities
  let sql = `
    SELECT DISTINCT k.*
    FROM entity_mentions em
    JOIN knowledge k ON k.id = em.knowledge_item_id
    WHERE em.entity_id IN (${ph})
      AND k.source NOT IN ('agent-report', 'agent-notification', 'briefing', 'directive', 'training')
  `;
  const params: any[] = [...entityIds];

  if (since) {
    sql += ` AND k.source_date >= ?`;
    params.push(since);
  }

  sql += ` ORDER BY k.source_date DESC LIMIT ?`;
  params.push(limit * 2);

  const rows = db.prepare(sql).all(...params) as any[];

  const entityNames = matchedEntities.map(e => e.name).join(', ');
  const scored = rows.map(row => {
    parseJsonFields(row);
    row.embedding = null;
    // Score: base 0.85 for direct entity mention, boosted by importance
    let score = 0.85;
    if (row.importance === 'critical') score = 1.0;
    else if (row.importance === 'high') score = 0.95;
    return { ...row, _score: score, _strategy: 'entity', _via: `entity mention: ${entityNames}` };
  });

  applyRecencyWeighting(scored, recencyBias);

  return scored
    .sort((a, b) => b._score - a._score)
    .slice(0, limit);
}

function temporalSearch(
  db: Database.Database,
  query: string,
  limit: number,
  sinceOverride?: string,
  recencyBias: number = 0.05,
): any[] {
  const { since, label } = sinceOverride
    ? { since: sinceOverride, label: 'custom range' }
    : getTemporalRange(query);

  const rows = db.prepare(
    `SELECT * FROM knowledge_primary
     WHERE source_date >= ?
     ORDER BY source_date DESC
     LIMIT ?`
  ).all(since, limit * 2) as any[];

  const now = new Date();
  const sevenDaysAgo = new Date(now); sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

  const mapped = rows.map(row => {
    parseJsonFields(row);
    row.embedding = null;

    // Score: recent items rank higher
    let score = 0.5;
    if (row.source_date) {
      const itemDate = new Date(row.source_date);
      if (itemDate >= sevenDaysAgo) score = 0.9;
      else {
        const daysAgo = (now.getTime() - itemDate.getTime()) / 86400000;
        score = Math.max(0.1, 1.0 - (daysAgo / 90));
      }
    }

    // Importance boost
    if (row.importance === 'critical') score *= 1.5;
    else if (row.importance === 'high') score *= 1.2;

    return { ...row, _score: Math.min(score, 1.0), _strategy: 'temporal', _temporal_label: label };
  });

  // Apply recency weighting on top of temporal's own scoring
  applyRecencyWeighting(mapped, recencyBias);

  return mapped
    .sort((a, b) => b._score - a._score)
    .slice(0, limit);
}

async function hierarchicalSearch(
  db: Database.Database,
  query: string,
  limit: number,
  apiKey: string,
  recencyBias: number = 0.05,
): Promise<any[]> {
  const queryEmb = await generateEmbedding(query, apiKey);

  // 1. Search themes by centroid similarity → top 3
  const themes = getThemes(db);
  const scoredThemes = themes
    .map(theme => {
      let sim = 0;
      if (theme.centroid) {
        const centroid = decodeEmbedding(theme.centroid);
        if (centroid) sim = cosineSimilarity(queryEmb, centroid);
      }
      return { ...theme, similarity: sim };
    })
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, 3);

  if (scoredThemes.length === 0) {
    // Fallback to semantic search
    return semanticSearch(db, query, limit, apiKey, recencyBias);
  }

  // 2. Collect semantic_ids from top themes
  const semanticIds = new Set<string>();
  for (const theme of scoredThemes) {
    const ids = Array.isArray(theme.semantic_ids) ? theme.semantic_ids : parseJsonField(theme.semantic_ids);
    for (const id of ids) semanticIds.add(id);
  }

  // 3. Rank semantics by query similarity
  const allSemantics = getSemantics(db, { current: true });
  const relevantSemantics = allSemantics
    .filter(s => semanticIds.has(s.id))
    .map(s => {
      let sim = 0;
      if (s.embedding) {
        const emb = decodeEmbedding(s.embedding);
        if (emb) sim = cosineSimilarity(queryEmb, emb);
      }
      return { ...s, similarity: sim };
    })
    .sort((a, b) => b.similarity - a.similarity);

  const avgSim = relevantSemantics.length > 0
    ? relevantSemantics.reduce((sum, s) => sum + s.similarity, 0) / relevantSemantics.length
    : 0;

  // 4. Collect item IDs from top semantics
  const itemIds = new Set<string>();
  for (const sem of relevantSemantics.slice(0, 15)) {
    const ids = Array.isArray(sem.item_ids) ? sem.item_ids : parseJsonField(sem.item_ids);
    for (const id of ids) itemIds.add(id);
  }

  // 5. If low confidence, expand via episodes
  if (avgSim < 0.5) {
    const episodeIds = new Set<string>();
    for (const sem of relevantSemantics) {
      const eids = Array.isArray(sem.episode_ids) ? sem.episode_ids : parseJsonField(sem.episode_ids);
      for (const eid of eids) episodeIds.add(eid);
    }

    if (episodeIds.size > 0) {
      const placeholders = Array.from(episodeIds).map(() => '?').join(',');
      const episodes = db.prepare(`SELECT item_ids FROM episodes WHERE id IN (${placeholders})`).all(...Array.from(episodeIds)) as any[];
      for (const ep of episodes) {
        const ids = parseJsonField(ep.item_ids);
        for (const id of ids) itemIds.add(id);
      }
    }
  }

  // 6. Fetch and score knowledge items
  if (itemIds.size === 0) {
    return semanticSearch(db, query, limit, apiKey, recencyBias);
  }

  const placeholders = Array.from(itemIds).map(() => '?').join(',');
  const rows = db.prepare(`SELECT * FROM knowledge_primary WHERE id IN (${placeholders})`).all(...Array.from(itemIds)) as any[];

  const scored = rows.map(row => {
    parseJsonFields(row);
    // Score by embedding similarity if available
    let score = 0.5;
    if (row.embedding) {
      const emb = decodeEmbedding(row.embedding);
      if (emb) score = cosineSimilarity(queryEmb, emb);
    }
    row.embedding = null;
    return { ...row, _score: score, _strategy: 'hierarchical' };
  });

  applyRecencyWeighting(scored, recencyBias);

  return scored
    .sort((a, b) => b._score - a._score)
    .slice(0, limit);
}

// ============================================================
// Reranking with Claude
// ============================================================

async function rerankResults(
  query: string,
  candidates: any[],
  provider: LLMProvider,
): Promise<{ items: any[]; confidence: number; recency: string; agreement: string }> {
  if (candidates.length === 0) {
    return { items: [], confidence: 0, recency: 'stale', agreement: 'consistent' };
  }

  // Send top 20 candidates for reranking
  const toRerank = candidates.slice(0, 20);

  const candidateList = toRerank.map((item, idx) => {
    const date = item.source_date || 'unknown';
    const contacts = Array.isArray(item.contacts) ? item.contacts.join(', ') : '';
    return `[${idx}] "${item.title}" (${item.source}, ${date}, importance: ${item.importance || 'normal'})\n    ${(item.summary || '').slice(0, 200)}${contacts ? `\n    Contacts: ${contacts}` : ''}`;
  }).join('\n');

  try {
    const response = await provider.chat(
      [
        {
          role: 'system',
          content: `You rank search results by relevance to a query. Consider:
1. Direct relevance to the query
2. Recency (prefer recent unless query asks for history)
3. Importance level (critical > high > normal > low)
4. Completeness (does this fully answer vs partially)

Return JSON only: {"ranked": [index_numbers_in_order], "confidence": 0.0-1.0, "coverage": "fresh|mixed|stale", "agreement": "consistent|mixed|conflicting"}

"ranked" must contain index numbers from the candidate list, most relevant first.
"confidence" is how well the results answer the query (1.0 = perfect coverage, 0.0 = nothing relevant).
"coverage" reflects recency: fresh = mostly <7 days, stale = mostly >30 days.
"agreement" reflects consistency: do results point same direction or contradict?`,
        },
        {
          role: 'user',
          content: `Query: "${query}"\n\nCandidates:\n${candidateList}`,
        },
      ],
      { temperature: 0.1, max_tokens: 500, json: true }
    );

    const result = JSON.parse(response);
    const ranked = (result.ranked || []) as number[];

    // Reorder candidates by ranked indices
    const reranked: any[] = [];
    const seen = new Set<number>();
    for (const idx of ranked) {
      if (idx >= 0 && idx < toRerank.length && !seen.has(idx)) {
        seen.add(idx);
        reranked.push(toRerank[idx]);
      }
    }
    // Add any candidates that weren't in the ranking
    for (let i = 0; i < toRerank.length; i++) {
      if (!seen.has(i)) reranked.push(toRerank[i]);
    }
    // Add remaining candidates beyond top 20
    reranked.push(...candidates.slice(20));

    return {
      items: reranked,
      confidence: result.confidence ?? 0.5,
      recency: result.coverage || 'mixed',
      agreement: result.agreement || 'consistent',
    };
  } catch {
    // Reranking failed — return original order
    return {
      items: candidates,
      confidence: computeConfidence(candidates),
      recency: computeRecency(candidates),
      agreement: 'consistent',
    };
  }
}

// ============================================================
// Confidence scoring (fallback when reranking is off)
// ============================================================

function computeConfidence(items: any[]): number {
  if (items.length === 0) return 0;
  const count = Math.min(items.length / 10, 1.0) * 0.4; // 0-0.4 based on count
  const avgScore = items.reduce((sum, i) => sum + (i._score || i.similarity || 0), 0) / items.length;
  const scoreComponent = avgScore * 0.6; // 0-0.6 based on avg score
  return Math.min(count + scoreComponent, 1.0);
}

function computeRecency(items: any[]): 'fresh' | 'mixed' | 'stale' {
  if (items.length === 0) return 'stale';
  const now = Date.now();
  const sevenDays = 7 * 86400000;
  const thirtyDays = 30 * 86400000;

  let fresh = 0, stale = 0;
  for (const item of items) {
    if (item.source_date) {
      const age = now - new Date(item.source_date).getTime();
      if (age < sevenDays) fresh++;
      else if (age > thirtyDays) stale++;
    }
  }

  if (fresh > items.length * 0.5) return 'fresh';
  if (stale > items.length * 0.5) return 'stale';
  return 'mixed';
}

// ============================================================
// Main search function
// ============================================================

export async function search(
  db: Database.Database,
  query: string,
  options: SearchOptions = {},
): Promise<SearchResult> {
  const {
    limit = 15,
    strategy = 'auto',
    project,
    source,
    since,
    rerank = true,
    recencyBias = 0.05,
    graphDepth = 2,
    similar_to,
  } = options;

  const apiKey = getConfig(db, 'openai_api_key');
  let candidates: any[] = [];
  let strategyUsed: string = strategy;

  // ── Similar-item search: use existing item's embedding as query vector ──
  if (similar_to) {
    const row = db.prepare('SELECT embedding FROM knowledge WHERE id = ?').get(similar_to) as any;
    if (row?.embedding) {
      const buf = row.embedding as Buffer;
      const floats = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
      const queryEmb = Array.from(floats);
      const results = searchByEmbedding(db, queryEmb, limit * 2, 0.2);
      candidates = results
        .filter(r => r.id !== similar_to)  // exclude the source item itself
        .map(r => ({ ...r, _score: r.similarity || 0, _strategy: 'similar' }));
      applyRecencyWeighting(candidates, recencyBias);
      strategyUsed = 'similar';

      // Apply filters and return early
      if (project) candidates = candidates.filter(r => r.project?.toLowerCase().includes(project.toLowerCase()));
      if (source) candidates = candidates.filter(r => r.source === source);
      if (since) candidates = candidates.filter(r => r.source_date && r.source_date >= since);
      candidates = deduplicateBySourceRef(candidates);

      const items = candidates.slice(0, limit);
      return {
        items,
        strategy_used: strategyUsed,
        confidence: computeConfidence(items),
        coverage: {
          sources_found: items.length,
          recency: computeRecency(items),
          agreement: 'consistent' as const,
        },
      };
    }
    // If no embedding found for similar_to item, fall through to normal search
  }

  // ── Execute strategy ───────────────────────────────────────

  if (strategy === 'semantic') {
    if (!apiKey) throw new Error('Semantic search requires an OpenAI API key for embeddings.');
    candidates = await semanticSearch(db, query, limit * 2, apiKey, recencyBias, since);
    strategyUsed = 'semantic';

  } else if (strategy === 'keyword') {
    candidates = keywordSearch(db, query, limit * 2, recencyBias, since);
    strategyUsed = 'keyword';

  } else if (strategy === 'graph') {
    candidates = graphTraversalSearch(db, query, limit * 2, recencyBias, graphDepth, since);
    strategyUsed = 'graph';

  } else if (strategy === 'temporal') {
    candidates = temporalSearch(db, query, limit * 2, since, recencyBias);
    strategyUsed = 'temporal';

  } else if (strategy === 'hierarchical') {
    if (!apiKey) throw new Error('Hierarchical search requires an OpenAI API key for embeddings.');
    candidates = await hierarchicalSearch(db, query, limit * 2, apiKey, recencyBias);
    strategyUsed = 'hierarchical';

  } else if (strategy === 'fts') {
    candidates = ftsSearch(db, query, limit * 2, recencyBias, since, source, project);
    strategyUsed = 'fts';

  } else if (strategy === 'entity') {
    candidates = entitySearch(db, query, limit * 2, recencyBias, since);
    strategyUsed = 'entity';

  } else {
    // ── Auto strategy: semantic + keyword + graph + FTS in parallel, plus extras ──
    strategyUsed = 'auto';

    const promises: Promise<any[]>[] = [];

    // Always run keyword (synchronous, wrapped in Promise.resolve)
    promises.push(Promise.resolve(keywordSearch(db, query, limit * 2, recencyBias, since)));

    // Run semantic if API key available
    if (apiKey) {
      promises.push(
        semanticSearch(db, query, limit * 2, apiKey, recencyBias, since).catch(() => [])
      );
    }

    // Always run graph traversal in parallel (synchronous, no LLM calls)
    promises.push(
      Promise.resolve(graphTraversalSearch(db, query, limit * 2, recencyBias, graphDepth, since))
    );

    // Always run FTS in parallel (synchronous, no LLM calls)
    promises.push(
      Promise.resolve(ftsSearch(db, query, limit * 2, recencyBias, since, source, project))
    );

    const results = await Promise.all(promises);
    const keywordResults = results[0];
    const semanticResults = apiKey ? results[1] : [];
    const graphResults = apiKey ? results[2] : results[1];
    const ftsResults = apiKey ? results[3] : results[2];

    // Merge: normalize scores per strategy and combine
    const maxKeyword = keywordResults.length > 0 ? Math.max(...keywordResults.map((r: any) => r._score)) : 1;
    const maxSemantic = semanticResults?.length > 0 ? Math.max(...semanticResults.map((r: any) => r._score)) : 1;
    const maxGraph = graphResults?.length > 0 ? Math.max(...graphResults.map((r: any) => r._score)) : 1;
    const maxFts = ftsResults?.length > 0 ? Math.max(...ftsResults.map((r: any) => r._score)) : 1;

    // scoreMap tracks per-strategy normalized scores per item
    const scoreMap = new Map<string, { item: any; semanticScore: number; keywordScore: number; graphScore: number; ftsScore: number }>();

    // Add semantic results
    if (semanticResults) {
      for (const item of semanticResults) {
        const normScore = maxSemantic > 0 ? item._score / maxSemantic : 0;
        scoreMap.set(item.id, { item, semanticScore: normScore, keywordScore: 0, graphScore: 0, ftsScore: 0 });
      }
    }

    // Add/merge keyword results
    for (const item of keywordResults) {
      const normScore = maxKeyword > 0 ? item._score / maxKeyword : 0;
      const existing = scoreMap.get(item.id);
      if (existing) {
        existing.keywordScore = normScore;
      } else {
        scoreMap.set(item.id, { item, semanticScore: 0, keywordScore: normScore, graphScore: 0, ftsScore: 0 });
      }
    }

    // Add/merge graph results
    if (graphResults) {
      for (const item of graphResults) {
        const normScore = maxGraph > 0 ? item._score / maxGraph : 0;
        const existing = scoreMap.get(item.id);
        if (existing) {
          existing.graphScore = normScore;
          // Preserve graph metadata on the item if graph scored higher
          if (normScore > existing.item._score) {
            existing.item._via = item._via;
            existing.item._thread_boost = item._thread_boost;
          }
        } else {
          scoreMap.set(item.id, { item, semanticScore: 0, keywordScore: 0, graphScore: normScore, ftsScore: 0 });
        }
      }
    }

    // Add/merge FTS results
    if (ftsResults) {
      for (const item of ftsResults) {
        const normScore = maxFts > 0 ? item._score / maxFts : 0;
        const existing = scoreMap.get(item.id);
        if (existing) {
          existing.ftsScore = normScore;
        } else {
          scoreMap.set(item.id, { item, semanticScore: 0, keywordScore: 0, graphScore: 0, ftsScore: normScore });
        }
      }
    }

    // Combined score: 0.45 semantic + 0.15 keyword + 0.20 graph + 0.20 FTS
    // When semantic is unavailable, reweight: 0.25 keyword + 0.35 graph + 0.40 FTS
    const hasSemantic = apiKey && semanticResults && semanticResults.length > 0;
    candidates = Array.from(scoreMap.values())
      .map(({ item, semanticScore, keywordScore, graphScore, ftsScore }) => {
        const combined = hasSemantic
          ? 0.45 * semanticScore + 0.15 * keywordScore + 0.20 * graphScore + 0.20 * ftsScore
          : 0.25 * keywordScore + 0.35 * graphScore + 0.40 * ftsScore;
        return {
          ...item,
          _score: combined,
          _strategy: 'auto',
        };
      })
      .sort((a, b) => b._score - a._score);

    // Track which strategies contributed
    const hasGraphHits = graphResults && graphResults.length > 0;
    const hasFtsHits = ftsResults && ftsResults.length > 0;
    if (hasGraphHits || hasFtsHits) {
      const parts = ['auto'];
      if (hasGraphHits) parts.push('graph');
      if (hasFtsHits) parts.push('fts');
      strategyUsed = parts.join('+');
    }

    // If temporal words detected, also run temporal and merge
    if (hasTemporalIntent(query)) {
      const temporalResults = temporalSearch(db, query, limit, since, recencyBias);
      for (const tr of temporalResults) {
        if (!candidates.find(c => c.id === tr.id)) {
          candidates.push({ ...tr, _score: tr._score * 0.8 }); // Slightly lower to blend
        }
      }
      strategyUsed = strategyUsed.includes('+') ? `${strategyUsed}+temporal` : 'auto+temporal';
    }

    // If query matches entity names, also run entity search and merge
    const matchedEntities = matchEntitiesFromQuery(db, query);
    if (matchedEntities.length > 0) {
      const entityResults = entitySearch(db, query, limit, recencyBias, since);
      for (const er of entityResults) {
        if (!candidates.find(c => c.id === er.id)) {
          candidates.push({ ...er, _score: er._score * 0.85 });
        }
      }
      strategyUsed = strategyUsed.includes('+') ? `${strategyUsed}+entity` : 'auto+entity';
    }
  }

  // ── Apply filters ──────────────────────────────────────────

  if (project) {
    candidates = candidates.filter(r =>
      r.project?.toLowerCase().includes(project.toLowerCase())
    );
  }
  if (source) {
    candidates = candidates.filter(r => r.source === source);
  }
  if (since) {
    candidates = candidates.filter(r => r.source_date && r.source_date >= since);
  }

  // Deduplicate: by source_ref (keep highest score per ref), then by id
  candidates = deduplicateBySourceRef(candidates);
  candidates = deduplicateById(candidates);

  // ── Rerank with Claude ─────────────────────────────────────

  let confidence: number;
  let recency: 'fresh' | 'mixed' | 'stale';
  let agreement: 'consistent' | 'mixed' | 'conflicting';

  if (rerank && candidates.length > 2) {
    try {
      const provider = await getDefaultProvider(apiKey || undefined);
      const reranked = await rerankResults(query, candidates, provider);
      candidates = reranked.items;
      confidence = reranked.confidence;
      recency = reranked.recency as any;
      agreement = reranked.agreement as any;
    } catch {
      // Reranking failed — use computed values
      confidence = computeConfidence(candidates);
      recency = computeRecency(candidates);
      agreement = 'consistent';
    }
  } else {
    confidence = computeConfidence(candidates);
    recency = computeRecency(candidates);
    agreement = 'consistent';
  }

  // ── Trim to limit ──────────────────────────────────────────

  const items = candidates.slice(0, limit);

  return {
    items,
    strategy_used: strategyUsed,
    confidence,
    coverage: {
      sources_found: items.length,
      recency,
      agreement,
    },
  };
}
