import Database from 'better-sqlite3';
import { existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const PRIME_DIR = join(homedir(), '.prime');
const DB_PATH = join(PRIME_DIR, 'prime.db');

// Belief System: Source classification
// Derived sources are the system's OWN output — never feed entity graph, search, or world model
export const DERIVED_SOURCES = ['agent-report', 'agent-notification', 'briefing', 'directive'] as const;

let _db: Database.Database | null = null;

export function ensurePrimeDir(): string {
  if (!existsSync(PRIME_DIR)) {
    mkdirSync(PRIME_DIR, { recursive: true });
  }
  for (const sub of ['artifacts', 'conversations', 'cache', 'logs']) {
    const dir = join(PRIME_DIR, sub);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  }
  return PRIME_DIR;
}

export function getDb(): Database.Database {
  if (_db) return _db;

  ensurePrimeDir();
  _db = new Database(DB_PATH);
  _db.pragma('journal_mode = WAL');
  _db.pragma('busy_timeout = 10000');

  initSchema(_db);
  return _db;
}

function initSchema(db: Database.Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS knowledge (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      summary TEXT NOT NULL,
      source TEXT NOT NULL,
      source_ref TEXT NOT NULL,
      source_date TEXT,
      contacts TEXT DEFAULT '[]',
      organizations TEXT DEFAULT '[]',
      decisions TEXT DEFAULT '[]',
      commitments TEXT DEFAULT '[]',
      action_items TEXT DEFAULT '[]',
      tags TEXT DEFAULT '[]',
      project TEXT,
      importance TEXT DEFAULT 'normal',
      valid_from TEXT DEFAULT (datetime('now')),
      valid_until TEXT,
      superseded_by TEXT,
      embedding BLOB,
      artifact_path TEXT,
      metadata TEXT DEFAULT '{}',
      raw_content TEXT,                        -- FULL source content (email body, transcript, conversation)
      extraction_version INTEGER DEFAULT 1,    -- 1=V1 metadata-only, 2=V2 with quotes, 3=V3 from raw_content
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS connections (
      id TEXT PRIMARY KEY,
      source_id TEXT REFERENCES knowledge(id) ON DELETE CASCADE,
      target_id TEXT REFERENCES knowledge(id) ON DELETE CASCADE,
      relationship TEXT NOT NULL,
      confidence REAL DEFAULT 1.0,
      created_at TEXT DEFAULT (datetime('now')),
      UNIQUE(source_id, target_id, relationship)
    );

    CREATE TABLE IF NOT EXISTS sync_state (
      source TEXT PRIMARY KEY,
      last_sync_at TEXT,
      last_cursor TEXT,
      items_synced INTEGER DEFAULT 0,
      status TEXT DEFAULT 'idle',
      error TEXT,
      config TEXT DEFAULT '{}',
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS config (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_knowledge_source ON knowledge(source);
    CREATE INDEX IF NOT EXISTS idx_knowledge_project ON knowledge(project);
    CREATE INDEX IF NOT EXISTS idx_knowledge_importance ON knowledge(importance);
    CREATE INDEX IF NOT EXISTS idx_knowledge_source_date ON knowledge(source_date);

    CREATE TABLE IF NOT EXISTS episodes (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      summary TEXT,
      item_ids TEXT NOT NULL,
      source TEXT,
      project TEXT,
      date_start TEXT,
      date_end TEXT,
      embedding BLOB,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS semantics (
      id TEXT PRIMARY KEY,
      fact TEXT NOT NULL,
      fact_type TEXT NOT NULL,
      episode_ids TEXT,
      item_ids TEXT,
      project TEXT,
      contacts TEXT,
      valid_from TEXT,
      valid_until TEXT,
      superseded_by TEXT,
      confidence REAL DEFAULT 1.0,
      embedding BLOB,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS themes (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      semantic_ids TEXT NOT NULL,
      parent_theme_id TEXT,
      size INTEGER DEFAULT 0,
      centroid BLOB,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_episodes_source ON episodes(source);
    CREATE INDEX IF NOT EXISTS idx_episodes_project ON episodes(project);
    CREATE INDEX IF NOT EXISTS idx_episodes_date_start ON episodes(date_start);
    CREATE INDEX IF NOT EXISTS idx_semantics_fact_type ON semantics(fact_type);
    CREATE INDEX IF NOT EXISTS idx_semantics_project ON semantics(project);
    CREATE INDEX IF NOT EXISTS idx_semantics_valid_until ON semantics(valid_until);
    CREATE INDEX IF NOT EXISTS idx_themes_parent ON themes(parent_theme_id);

    CREATE TABLE IF NOT EXISTS commitments (
      id TEXT PRIMARY KEY,
      text TEXT NOT NULL,
      owner TEXT,
      assigned_to TEXT,
      due_date TEXT,
      detected_from TEXT,
      detected_at TEXT DEFAULT (datetime('now')),
      state TEXT DEFAULT 'detected',
      state_changed_at TEXT,
      fulfilled_evidence TEXT,
      context TEXT,
      project TEXT,
      importance TEXT DEFAULT 'normal',
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_commitments_state ON commitments(state);
    CREATE INDEX IF NOT EXISTS idx_commitments_due ON commitments(due_date);
    CREATE INDEX IF NOT EXISTS idx_commitments_owner ON commitments(owner);

    -- ============================================================
    -- ENTITY GRAPH (Phase 2 of v1.0 Brain Architecture)
    -- ============================================================

    CREATE TABLE IF NOT EXISTS entities (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      canonical_name TEXT NOT NULL,
      email TEXT,
      domain TEXT,
      relationship_type TEXT,
      relationship_confidence REAL DEFAULT 0.0,
      user_label TEXT,
      user_dismissed INTEGER DEFAULT 0,
      user_notes TEXT,
      properties TEXT DEFAULT '{}',
      first_seen_date TEXT,
      last_seen_date TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS entity_aliases (
      id TEXT PRIMARY KEY,
      entity_id TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
      alias TEXT NOT NULL,
      alias_normalized TEXT NOT NULL,
      source TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      UNIQUE(entity_id, alias_normalized)
    );

    CREATE TABLE IF NOT EXISTS entity_mentions (
      id TEXT PRIMARY KEY,
      entity_id TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
      knowledge_item_id TEXT NOT NULL,
      role TEXT,
      direction TEXT,
      mention_date TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      UNIQUE(entity_id, knowledge_item_id, role)
    );

    CREATE TABLE IF NOT EXISTS entity_edges (
      id TEXT PRIMARY KEY,
      source_entity_id TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
      target_entity_id TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
      edge_type TEXT NOT NULL,
      co_occurrence_count INTEGER DEFAULT 0,
      confidence REAL DEFAULT 0.0,
      user_confirmed INTEGER DEFAULT 0,
      user_denied INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      UNIQUE(source_entity_id, target_entity_id, edge_type)
    );

    CREATE TABLE IF NOT EXISTS edge_evidence (
      id TEXT PRIMARY KEY,
      edge_id TEXT NOT NULL REFERENCES entity_edges(id) ON DELETE CASCADE,
      knowledge_item_id TEXT NOT NULL,
      quote TEXT,
      evidence_date TEXT,
      UNIQUE(edge_id, knowledge_item_id)
    );

    CREATE TABLE IF NOT EXISTS dismissals (
      id TEXT PRIMARY KEY,
      entity_id TEXT REFERENCES entities(id) ON DELETE CASCADE,
      knowledge_item_id TEXT,
      pattern TEXT,
      domain TEXT,
      reason TEXT,
      dismissed_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS entity_signals (
      id TEXT PRIMARY KEY,
      entity_id TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
      signal_type TEXT NOT NULL,
      count INTEGER DEFAULT 1,
      last_seen TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      UNIQUE(entity_id, signal_type)
    );

    CREATE TABLE IF NOT EXISTS graph_state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT DEFAULT (datetime('now'))
    );

    -- ============================================================
    -- FACTS TABLE (Phase 3 — subsumes semantics)
    -- ============================================================

    CREATE TABLE IF NOT EXISTS facts (
      id TEXT PRIMARY KEY,
      tier TEXT NOT NULL,
      fact_type TEXT NOT NULL,
      text TEXT NOT NULL,
      quote TEXT,
      source_item_id TEXT,
      basis_count INTEGER,
      basis_item_ids TEXT,
      confidence REAL DEFAULT 1.0,
      entity_ids TEXT DEFAULT '[]',
      project TEXT,
      valid_from TEXT,
      valid_until TEXT,
      superseded_by TEXT,
      embedding BLOB,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_facts_project ON facts(project) WHERE valid_until IS NULL;
    CREATE INDEX IF NOT EXISTS idx_facts_type ON facts(fact_type, tier) WHERE valid_until IS NULL;
    CREATE INDEX IF NOT EXISTS idx_facts_source ON facts(source_item_id) WHERE source_item_id IS NOT NULL;

    -- ============================================================
    -- ARTIFACTS TABLE — versioned, full-content, cross-project
    -- ============================================================

    CREATE TABLE IF NOT EXISTS artifacts (
      id TEXT PRIMARY KEY,
      identifier TEXT NOT NULL,          -- artifact identifier (stable across versions)
      title TEXT NOT NULL,
      type TEXT NOT NULL,                -- 'code', 'document', 'analysis', 'design', 'spreadsheet'
      version INTEGER DEFAULT 1,
      is_latest INTEGER DEFAULT 1,       -- only 1 per identifier
      content TEXT NOT NULL,             -- FULL content (not truncated)
      content_length INTEGER,
      conversation_uuid TEXT,            -- source conversation
      conversation_name TEXT,
      project TEXT,
      knowledge_item_id TEXT,            -- link to knowledge table
      embedding BLOB,                    -- for semantic search on content
      tags TEXT DEFAULT '[]',
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_artifacts_identifier ON artifacts(identifier);
    CREATE INDEX IF NOT EXISTS idx_artifacts_title ON artifacts(title);
    CREATE INDEX IF NOT EXISTS idx_artifacts_latest ON artifacts(identifier, is_latest) WHERE is_latest = 1;
    CREATE INDEX IF NOT EXISTS idx_artifacts_project ON artifacts(project);
    CREATE INDEX IF NOT EXISTS idx_artifacts_type ON artifacts(type);

    -- ============================================================
    -- Entity Understanding Profiles
    -- Rich comprehension of each entity, not just a label
    -- Updated by dream pipeline, consumed by alert system
    -- ============================================================
    CREATE TABLE IF NOT EXISTS entity_profiles (
      entity_id TEXT PRIMARY KEY REFERENCES entities(id) ON DELETE CASCADE,
      communication_nature TEXT NOT NULL DEFAULT 'unknown',   -- 'transactional','relational','strategic','informational','spam'
      reply_expectation TEXT NOT NULL DEFAULT 'unknown',      -- 'never','rarely','sometimes','usually','always'
      email_types TEXT DEFAULT '[]',                          -- JSON: ['invoice','policy','acknowledgment','question','proposal']
      importance_to_business TEXT DEFAULT 'unknown',          -- 'critical','high','medium','low','none'
      importance_evidence TEXT DEFAULT '',                     -- why this importance rating
      relationship_evidence TEXT DEFAULT '',                   -- what data supports the relationship classification
      alert_verdict TEXT DEFAULT 'pending',                   -- 'surface','suppress','pending'
      verdict_reasoning TEXT DEFAULT '',                       -- LLM explanation of verdict
      verdict_confidence REAL DEFAULT 0.0,
      last_verified_at TEXT,                                  -- when dream pipeline last evaluated
      user_override INTEGER DEFAULT 0,                        -- user explicitly set this (never auto-change)
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    -- ============================================================
    -- Alert Verdicts
    -- Pre-computed by dream pipeline, consumed by real-time getAlerts
    -- Each entity with open threads gets a verdict
    -- ============================================================
    CREATE TABLE IF NOT EXISTS alert_verdicts (
      id TEXT PRIMARY KEY,
      entity_id TEXT REFERENCES entities(id) ON DELETE CASCADE,
      entity_name TEXT NOT NULL,
      verdict TEXT NOT NULL,                 -- 'surface','suppress','defer'
      confidence REAL NOT NULL DEFAULT 0.0,
      reasoning TEXT NOT NULL DEFAULT '',    -- LLM explanation
      severity TEXT DEFAULT 'normal',       -- 'critical','high','normal'
      suggested_action TEXT,                -- 'reply','call','dismiss','defer'
      open_thread_count INTEGER DEFAULT 0,
      oldest_thread_days INTEGER DEFAULT 0,
      context_summary TEXT,                 -- brief context for COS
      computed_at TEXT DEFAULT (datetime('now')),
      expires_at TEXT,                      -- stale after this time
      user_acted INTEGER DEFAULT 0,         -- did user act on this?
      user_action TEXT                      -- what did user do?
    );

    CREATE INDEX IF NOT EXISTS idx_verdicts_entity ON alert_verdicts(entity_id);
    CREATE INDEX IF NOT EXISTS idx_verdicts_verdict ON alert_verdicts(verdict, confidence DESC);
    CREATE INDEX IF NOT EXISTS idx_verdicts_expires ON alert_verdicts(expires_at);
    CREATE INDEX IF NOT EXISTS idx_profiles_verdict ON entity_profiles(alert_verdict);
    CREATE INDEX IF NOT EXISTS idx_profiles_nature ON entity_profiles(communication_nature);

    -- Entity indexes
    CREATE UNIQUE INDEX IF NOT EXISTS idx_entities_email ON entities(email) WHERE email IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_entities_type ON entities(type);
    CREATE INDEX IF NOT EXISTS idx_entities_name ON entities(canonical_name);
    CREATE INDEX IF NOT EXISTS idx_entities_relationship ON entities(relationship_type);
    CREATE INDEX IF NOT EXISTS idx_entities_active ON entities(user_dismissed, last_seen_date DESC);
    CREATE INDEX IF NOT EXISTS idx_entity_aliases_normalized ON entity_aliases(alias_normalized);
    CREATE INDEX IF NOT EXISTS idx_mentions_entity ON entity_mentions(entity_id, mention_date DESC);
    CREATE INDEX IF NOT EXISTS idx_mentions_item ON entity_mentions(knowledge_item_id);
    CREATE INDEX IF NOT EXISTS idx_mentions_direction ON entity_mentions(entity_id, direction);
    CREATE INDEX IF NOT EXISTS idx_edges_source ON entity_edges(source_entity_id);
    CREATE INDEX IF NOT EXISTS idx_edges_target ON entity_edges(target_entity_id);
    CREATE INDEX IF NOT EXISTS idx_evidence_edge ON edge_evidence(edge_id);
    CREATE INDEX IF NOT EXISTS idx_evidence_item ON edge_evidence(knowledge_item_id);
    CREATE INDEX IF NOT EXISTS idx_dismissals_domain ON dismissals(domain) WHERE domain IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_dismissals_pattern ON dismissals(pattern) WHERE pattern IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_dismissals_entity ON dismissals(entity_id) WHERE entity_id IS NOT NULL;

    -- ============================================================
    -- Provenance Views — Belief System Architecture
    -- knowledge_primary: ONLY primary observations (real emails, meetings, conversations)
    -- knowledge_derived: ONLY system outputs (agent reports, briefings, directives)
    --
    -- Entity graph, world model, alerts, and search use knowledge_primary.
    -- Agent activity tracking and self-audit use knowledge_derived.
    -- Raw knowledge table used ONLY for exports and admin queries.
    --
    -- Uses NOT IN so new source types default to PRIMARY (safe default).
    -- ============================================================
    CREATE VIEW IF NOT EXISTS knowledge_primary AS
      SELECT * FROM knowledge
      WHERE source NOT IN ('agent-report', 'agent-notification', 'briefing', 'directive');

    CREATE VIEW IF NOT EXISTS knowledge_derived AS
      SELECT * FROM knowledge
      WHERE source IN ('agent-report', 'agent-notification', 'briefing', 'directive');

    -- ============================================================
    -- Staged Actions — prepared by dream pipeline, approved by user
    -- The bridge from intelligence to execution
    -- ============================================================
    CREATE TABLE IF NOT EXISTS staged_actions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL,              -- 'email', 'calendar', 'reminder'
      summary TEXT NOT NULL,           -- human-readable one-liner
      payload TEXT NOT NULL,           -- JSON: {to, subject, body} or {title, start_time}
      reasoning TEXT,                  -- why the system recommends this
      project TEXT,
      source_task TEXT DEFAULT 'dream-09',
      status TEXT DEFAULT 'pending',   -- 'pending', 'approved', 'rejected', 'expired', 'executed'
      created_at TEXT DEFAULT (datetime('now')),
      expires_at TEXT,                 -- 72h hard expiry + expire-on-new-run
      acted_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_staged_actions_status ON staged_actions(status);

    -- Index on source for efficient view filtering
    CREATE INDEX IF NOT EXISTS idx_knowledge_source ON knowledge(source);
  `);
}

export interface KnowledgeItem {
  id: string;
  title: string;
  summary: string;
  source: string;
  source_ref: string;
  source_date?: string;
  contacts?: string[];
  organizations?: string[];
  decisions?: string[];
  commitments?: string[];
  action_items?: string[];
  tags?: string[];
  project?: string | null;
  importance?: string;
  embedding?: number[];
  artifact_path?: string;
  metadata?: Record<string, any>;
}

export function insertKnowledge(db: Database.Database, item: KnowledgeItem) {
  const embeddingBlob = item.embedding
    ? Buffer.from(new Float32Array(item.embedding).buffer)
    : null;

  db.prepare(
    `INSERT OR REPLACE INTO knowledge
    (id, title, summary, source, source_ref, source_date, contacts, organizations,
     decisions, commitments, action_items, tags, project, importance, embedding,
     artifact_path, metadata, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`
  ).run(
    item.id,
    item.title,
    item.summary,
    item.source,
    item.source_ref,
    item.source_date || null,
    JSON.stringify(item.contacts || []),
    JSON.stringify(item.organizations || []),
    JSON.stringify(item.decisions || []),
    JSON.stringify(item.commitments || []),
    JSON.stringify(item.action_items || []),
    JSON.stringify(item.tags || []),
    item.project || null,
    item.importance || 'normal',
    embeddingBlob,
    item.artifact_path || null,
    JSON.stringify(item.metadata || {}),
  );
}

export function searchByText(db: Database.Database, query: string, limit = 20): any[] {
  const pattern = `%${query}%`;
  const rows = db.prepare(
    `SELECT * FROM knowledge_primary
    WHERE title LIKE ? OR summary LIKE ? OR contacts LIKE ? OR organizations LIKE ? OR tags LIKE ?
    ORDER BY
      CASE importance
        WHEN 'critical' THEN 0
        WHEN 'high' THEN 1
        WHEN 'normal' THEN 2
        WHEN 'low' THEN 3
      END,
      source_date DESC
    LIMIT ?`
  ).all(pattern, pattern, pattern, pattern, pattern, limit) as any[];

  for (const row of rows) {
    for (const field of ['contacts', 'organizations', 'decisions', 'commitments', 'action_items', 'tags', 'metadata']) {
      if (row[field] && typeof row[field] === 'string') {
        try { row[field] = JSON.parse(row[field] as string); } catch {}
      }
    }
  }
  return rows;
}

export function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

export function searchByEmbedding(db: Database.Database, queryEmbedding: number[], limit = 10, threshold = 0.7): any[] {
  const items = db.prepare('SELECT * FROM knowledge_primary WHERE embedding IS NOT NULL').all() as any[];
  if (!items.length) return [];

  const scored = items
    .map(obj => {
      // Decode embedding from Buffer
      if (obj.embedding && Buffer.isBuffer(obj.embedding)) {
        const buf = obj.embedding as Buffer;
        const floats = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
        const similarity = cosineSimilarity(queryEmbedding, Array.from(floats));
        obj.similarity = similarity;
        obj.embedding = null;
      } else {
        obj.similarity = 0;
      }

      // Parse JSON fields
      for (const field of ['contacts', 'organizations', 'decisions', 'commitments', 'action_items', 'tags', 'metadata']) {
        if (obj[field] && typeof obj[field] === 'string') {
          try { obj[field] = JSON.parse(obj[field]); } catch {}
        }
      }

      return obj;
    })
    .filter(obj => obj.similarity >= threshold)
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, limit);

  return scored;
}

// ── Semantics → Facts migration ─────────────────────────────

export function migrateSemanticsToFacts(db: Database.Database): { migrated: number; skipped: number } {
  const existingFacts = (db.prepare('SELECT COUNT(*) as cnt FROM facts').get() as any).cnt;
  if (existingFacts > 0) {
    return { migrated: 0, skipped: existingFacts }; // already migrated
  }

  const semantics = db.prepare('SELECT * FROM semantics').all() as any[];
  let migrated = 0;

  const insert = db.prepare(`
    INSERT OR IGNORE INTO facts (id, tier, fact_type, text, basis_count, basis_item_ids, confidence, entity_ids, project, valid_from, valid_until, superseded_by, embedding, created_at)
    VALUES (?, 'pattern', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  for (const s of semantics) {
    const itemIds = s.item_ids || s.episode_ids || '[]';
    const basisCount = (() => {
      try { return JSON.parse(itemIds).length || 1; } catch { return 1; }
    })();

    insert.run(
      s.id,
      s.fact_type,
      s.fact,
      basisCount,
      itemIds,
      s.confidence || 1.0,
      s.contacts || '[]',
      s.project,
      s.valid_from,
      s.valid_until,
      s.superseded_by,
      s.embedding,
      s.created_at || new Date().toISOString()
    );
    migrated++;
  }

  return { migrated, skipped: 0 };
}

export function getStats(db: Database.Database) {
  const total = db.prepare('SELECT COUNT(*) as count FROM knowledge').get() as any;
  const bySrc = db.prepare('SELECT source, COUNT(*) as count FROM knowledge GROUP BY source').all() as any[];
  const byImportance = db.prepare('SELECT importance, COUNT(*) as count FROM knowledge GROUP BY importance').all() as any[];
  const connections = db.prepare('SELECT COUNT(*) as count FROM connections').get() as any;
  const lastSync = db.prepare('SELECT source, last_sync_at, items_synced FROM sync_state ORDER BY last_sync_at DESC').all() as any[];

  return {
    total_items: total?.count || 0,
    by_source: bySrc.map(r => ({ source: r.source, count: r.count })),
    by_importance: byImportance.map(r => ({ importance: r.importance, count: r.count })),
    total_connections: connections?.count || 0,
    sync_state: lastSync.map(r => ({ source: r.source, last_sync_at: r.last_sync_at, items_synced: r.items_synced })),
  };
}

export function getConfig(db: Database.Database, key: string): any {
  const result = db.prepare('SELECT value FROM config WHERE key = ?').get(key) as any;
  if (!result) return null;
  try { return JSON.parse(result.value); } catch { return result.value; }
}

export function setConfig(db: Database.Database, key: string, value: any) {
  db.prepare('INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)').run(key, JSON.stringify(value));
}

export function getAllKnowledge(db: Database.Database, limit?: number): any[] {
  const rows = limit
    ? db.prepare('SELECT * FROM knowledge ORDER BY source_date DESC LIMIT ?').all(limit) as any[]
    : db.prepare('SELECT * FROM knowledge ORDER BY source_date DESC').all() as any[];

  for (const row of rows) {
    for (const field of ['contacts', 'organizations', 'decisions', 'commitments', 'action_items', 'tags', 'metadata']) {
      if (row[field] && typeof row[field] === 'string') {
        try { row[field] = JSON.parse(row[field] as string); } catch {}
      }
    }
  }
  return rows;
}

export function updateKnowledgeExtraction(db: Database.Database, id: string, fields: {
  contacts?: string[];
  organizations?: string[];
  decisions?: string[];
  commitments?: string[];
  action_items?: string[];
  tags?: string[];
  project?: string | null;
  importance?: string;
}) {
  db.prepare(
    `UPDATE knowledge SET
      contacts = ?, organizations = ?, decisions = ?, commitments = ?,
      action_items = ?, tags = ?, project = ?, importance = ?,
      updated_at = datetime('now')
    WHERE id = ?`
  ).run(
    JSON.stringify(fields.contacts || []),
    JSON.stringify(fields.organizations || []),
    JSON.stringify(fields.decisions || []),
    JSON.stringify(fields.commitments || []),
    JSON.stringify(fields.action_items || []),
    JSON.stringify(fields.tags || []),
    fields.project || null,
    fields.importance || 'normal',
    id,
  );
}

// ============================================================
// Episode types and functions
// ============================================================

export interface Episode {
  id: string;
  title: string;
  summary?: string;
  item_ids: string[];
  source?: string;
  project?: string;
  date_start?: string;
  date_end?: string;
  embedding?: number[];
}

export function insertEpisode(db: Database.Database, episode: Episode) {
  const embeddingBlob = episode.embedding
    ? Buffer.from(new Float32Array(episode.embedding).buffer)
    : null;

  db.prepare(
    `INSERT OR REPLACE INTO episodes
    (id, title, summary, item_ids, source, project, date_start, date_end, embedding)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    episode.id,
    episode.title,
    episode.summary || null,
    JSON.stringify(episode.item_ids),
    episode.source || null,
    episode.project || null,
    episode.date_start || null,
    episode.date_end || null,
    embeddingBlob,
  );
}

export function getEpisodes(db: Database.Database, limit?: number): any[] {
  const rows = limit
    ? db.prepare('SELECT * FROM episodes ORDER BY date_start DESC LIMIT ?').all(limit) as any[]
    : db.prepare('SELECT * FROM episodes ORDER BY date_start DESC').all() as any[];

  for (const row of rows) {
    if (row.item_ids && typeof row.item_ids === 'string') {
      try { row.item_ids = JSON.parse(row.item_ids); } catch {}
    }
  }
  return rows;
}

// ============================================================
// Semantic types and functions
// ============================================================

export interface Semantic {
  id: string;
  fact: string;
  fact_type: string;
  episode_ids?: string[];
  item_ids?: string[];
  project?: string;
  contacts?: string[];
  valid_from?: string;
  valid_until?: string;
  superseded_by?: string;
  confidence?: number;
  embedding?: number[];
}

export function insertSemantic(db: Database.Database, semantic: Semantic) {
  const embeddingBlob = semantic.embedding
    ? Buffer.from(new Float32Array(semantic.embedding).buffer)
    : null;

  db.prepare(
    `INSERT OR REPLACE INTO semantics
    (id, fact, fact_type, episode_ids, item_ids, project, contacts, valid_from, valid_until, superseded_by, confidence, embedding)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    semantic.id,
    semantic.fact,
    semantic.fact_type,
    JSON.stringify(semantic.episode_ids || []),
    JSON.stringify(semantic.item_ids || []),
    semantic.project || null,
    JSON.stringify(semantic.contacts || []),
    semantic.valid_from || null,
    semantic.valid_until || null,
    semantic.superseded_by || null,
    semantic.confidence ?? 1.0,
    embeddingBlob,
  );
}

export function getSemantics(db: Database.Database, options?: { project?: string; factType?: string; current?: boolean }): any[] {
  let sql = 'SELECT * FROM semantics WHERE 1=1';
  const params: any[] = [];

  if (options?.project) {
    sql += ' AND project = ?';
    params.push(options.project);
  }
  if (options?.factType) {
    sql += ' AND fact_type = ?';
    params.push(options.factType);
  }
  if (options?.current) {
    sql += ' AND valid_until IS NULL';
  }

  sql += ' ORDER BY created_at DESC';

  const rows = db.prepare(sql).all(...params) as any[];

  for (const row of rows) {
    for (const field of ['episode_ids', 'item_ids', 'contacts']) {
      if (row[field] && typeof row[field] === 'string') {
        try { row[field] = JSON.parse(row[field] as string); } catch {}
      }
    }
  }
  return rows;
}

// ============================================================
// Theme types and functions
// ============================================================

export interface Theme {
  id: string;
  name: string;
  description?: string;
  semantic_ids: string[];
  parent_theme_id?: string;
  size?: number;
  centroid?: number[];
}

export function insertTheme(db: Database.Database, theme: Theme) {
  const centroidBlob = theme.centroid
    ? Buffer.from(new Float32Array(theme.centroid).buffer)
    : null;

  db.prepare(
    `INSERT OR REPLACE INTO themes
    (id, name, description, semantic_ids, parent_theme_id, size, centroid, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))`
  ).run(
    theme.id,
    theme.name,
    theme.description || null,
    JSON.stringify(theme.semantic_ids),
    theme.parent_theme_id || null,
    theme.size ?? theme.semantic_ids.length,
    centroidBlob,
  );
}

export function getThemes(db: Database.Database): any[] {
  const rows = db.prepare('SELECT * FROM themes ORDER BY size DESC').all() as any[];

  for (const row of rows) {
    if (row.semantic_ids && typeof row.semantic_ids === 'string') {
      try { row.semantic_ids = JSON.parse(row.semantic_ids); } catch {}
    }
  }
  return rows;
}

// ============================================================
// Hierarchy stats
// ============================================================

export function getHierarchyStats(db: Database.Database): { themes: number; semantics: number; episodes: number; items: number } {
  const themes = db.prepare('SELECT COUNT(*) as count FROM themes').get() as any;
  const semantics = db.prepare('SELECT COUNT(*) as count FROM semantics').get() as any;
  const episodes = db.prepare('SELECT COUNT(*) as count FROM episodes').get() as any;
  const items = db.prepare('SELECT COUNT(*) as count FROM knowledge').get() as any;

  return {
    themes: themes?.count || 0,
    semantics: semantics?.count || 0,
    episodes: episodes?.count || 0,
    items: items?.count || 0,
  };
}

// ============================================================
// Connection functions
// ============================================================

export interface Connection {
  id: string;
  source_id: string;
  target_id: string;
  relationship: string;
  confidence: number;
}

export function insertConnection(db: Database.Database, conn: { id: string; source_id: string; target_id: string; relationship: string; confidence: number }) {
  db.prepare(
    `INSERT OR IGNORE INTO connections (id, source_id, target_id, relationship, confidence) VALUES (?, ?, ?, ?, ?)`
  ).run(conn.id, conn.source_id, conn.target_id, conn.relationship, conn.confidence);
}

export function getConnectionsForItem(db: Database.Database, itemId: string): Connection[] {
  const rows = db.prepare(
    `SELECT * FROM connections WHERE source_id = ? OR target_id = ?`
  ).all(itemId, itemId) as any[];

  return rows.map(row => ({
    id: row.id as string,
    source_id: row.source_id as string,
    target_id: row.target_id as string,
    relationship: row.relationship as string,
    confidence: row.confidence as number,
  }));
}

export function clearConnections(db: Database.Database) {
  db.prepare('DELETE FROM connections').run();
}

export function getConnectionStats(db: Database.Database): Record<string, number> {
  const rows = db.prepare('SELECT relationship, COUNT(*) as count FROM connections GROUP BY relationship').all() as any[];
  const stats: Record<string, number> = {};
  for (const row of rows) {
    stats[row.relationship as string] = row.count as number;
  }
  return stats;
}

// ============================================================
// Commitment types and functions
// ============================================================

export interface Commitment {
  id: string;
  text: string;
  owner?: string;
  assigned_to?: string;
  due_date?: string;
  detected_from?: string;
  detected_at?: string;
  state?: string;
  state_changed_at?: string;
  fulfilled_evidence?: string;
  context?: string;
  project?: string;
  importance?: string;
}

export function insertCommitment(db: Database.Database, commitment: Commitment) {
  db.prepare(
    `INSERT OR REPLACE INTO commitments
    (id, text, owner, assigned_to, due_date, detected_from, detected_at, state, state_changed_at, fulfilled_evidence, context, project, importance, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`
  ).run(
    commitment.id,
    commitment.text,
    commitment.owner || null,
    commitment.assigned_to || null,
    commitment.due_date || null,
    commitment.detected_from || null,
    commitment.detected_at || null,
    commitment.state || 'detected',
    commitment.state_changed_at || null,
    commitment.fulfilled_evidence || null,
    commitment.context || null,
    commitment.project || null,
    commitment.importance || 'normal',
  );
}

export function getCommitments(db: Database.Database, options?: { state?: string; owner?: string; project?: string; overdue?: boolean }): any[] {
  let sql = 'SELECT * FROM commitments WHERE 1=1';
  const params: any[] = [];

  if (options?.state) {
    sql += ' AND state = ?';
    params.push(options.state);
  }
  if (options?.owner) {
    sql += ' AND (owner = ? OR assigned_to = ?)';
    params.push(options.owner, options.owner);
  }
  if (options?.project) {
    sql += ' AND project = ?';
    params.push(options.project);
  }
  if (options?.overdue) {
    sql += " AND state = 'active' AND due_date < datetime('now')";
  }

  sql += ' ORDER BY due_date ASC, importance DESC';

  return db.prepare(sql).all(...params) as any[];
}

export function updateCommitmentState(db: Database.Database, id: string, newState: string, evidence?: string) {
  db.prepare(
    `UPDATE commitments SET state = ?, state_changed_at = datetime('now'), fulfilled_evidence = COALESCE(?, fulfilled_evidence), updated_at = datetime('now') WHERE id = ?`
  ).run(newState, evidence || null, id);
}

export function getCommitmentStats(db: Database.Database): { total: number; byState: Record<string, number>; overdueCount: number } {
  const total = db.prepare('SELECT COUNT(*) as count FROM commitments').get() as any;
  const byState = db.prepare('SELECT state, COUNT(*) as count FROM commitments GROUP BY state').all() as any[];
  const overdue = db.prepare("SELECT COUNT(*) as count FROM commitments WHERE state = 'active' AND due_date < datetime('now')").get() as any;

  const stateMap: Record<string, number> = {};
  for (const row of byState) {
    stateMap[row.state as string] = row.count as number;
  }

  return {
    total: total?.count || 0,
    byState: stateMap,
    overdueCount: overdue?.count || 0,
  };
}

export type { Database } from 'better-sqlite3';
export { PRIME_DIR, DB_PATH };
