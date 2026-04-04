import type Database from 'better-sqlite3';
import { v4 as uuid } from 'uuid';
import { getConfig, setConfig } from './db.js';

// ============================================================
// Entity Graph Builder — Phase 2 of v1.0 Brain Architecture
// ============================================================

// ── Name normalization ────────────────────────────────────────

function normalizeName(name: string): string {
  return name
    .toLowerCase()
    .replace(/\b(jr|sr|ii|iii|iv|esq|phd|md|dds)\b\.?/gi, '')
    .replace(/\b[a-z]\.\s*/g, '') // remove middle initials like "S."
    .replace(/[^a-z\s-]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseEmailFromHeader(header: string): { name: string; email: string } | null {
  // "Forrest Pullen <forrest@recaptureinsurance.com>"
  const match = header.match(/^(.+?)\s*<(.+?)>$/);
  if (match) return { name: match[1].trim().replace(/^"|"$/g, ''), email: match[2].toLowerCase() };

  // "forrest@recaptureinsurance.com"
  if (header.includes('@') && !header.includes(' ')) {
    return { name: '', email: header.toLowerCase() };
  }

  return null;
}

function extractDomain(email: string): string | null {
  const parts = email.split('@');
  if (parts.length !== 2) return null;
  const domain = parts[1].toLowerCase();
  // Skip generic domains
  const generic = ['gmail.com', 'yahoo.com', 'hotmail.com', 'outlook.com', 'icloud.com', 'aol.com', 'me.com', 'live.com'];
  if (generic.includes(domain)) return null;
  return domain;
}

// ── Entity CRUD ──────────────────────────────────────────────

export function getEntity(db: Database.Database, nameOrEmail: string): any {
  // Try exact canonical name first (most common case)
  const byName = db.prepare('SELECT * FROM entities WHERE canonical_name = ?').get(nameOrEmail);
  if (byName) return byName;

  // Try email match
  const byEmail = db.prepare('SELECT * FROM entities WHERE email = ?').get(nameOrEmail.toLowerCase());
  if (byEmail) return byEmail;

  // Try case-insensitive canonical name
  const byNameCI = db.prepare('SELECT * FROM entities WHERE LOWER(canonical_name) = LOWER(?)').get(nameOrEmail);
  if (byNameCI) return byNameCI;

  // Try alias lookup
  const normalized = normalizeName(nameOrEmail);
  const alias = db.prepare(
    'SELECT entity_id FROM entity_aliases WHERE alias_normalized = ?'
  ).get(normalized) as any;
  if (alias) {
    return db.prepare('SELECT * FROM entities WHERE id = ?').get(alias.entity_id);
  }

  // Try partial name match (first name → full name, excluding emails)
  const partial = db.prepare(
    "SELECT * FROM entities WHERE canonical_name LIKE ? AND canonical_name NOT LIKE '%@%' AND user_dismissed = 0 ORDER BY last_seen_date DESC LIMIT 1"
  ).get(`${nameOrEmail}%`) as any;
  if (partial) return partial;

  return null;
}

export function listEntities(db: Database.Database, options: {
  type?: string;
  dismissed?: boolean;
  limit?: number;
} = {}): any[] {
  const limit = options.limit || 100;
  let sql = 'SELECT e.*, ';
  sql += '(SELECT COUNT(*) FROM entity_mentions em WHERE em.entity_id = e.id) as mention_count ';
  sql += 'FROM entities e WHERE 1=1 ';

  const params: any[] = [];
  if (options.type) { sql += 'AND e.type = ? '; params.push(options.type); }
  if (options.dismissed === false) { sql += 'AND e.user_dismissed = 0 '; }
  if (options.dismissed === true) { sql += 'AND e.user_dismissed = 1 '; }

  sql += 'ORDER BY mention_count DESC LIMIT ?';
  params.push(limit);

  return db.prepare(sql).all(...params) as any[];
}

export function labelEntity(db: Database.Database, nameOrEmail: string, label: string): boolean {
  const entity = getEntity(db, nameOrEmail);
  if (!entity) return false;

  db.prepare('UPDATE entities SET user_label = ?, relationship_type = ?, relationship_confidence = 1.0, updated_at = datetime(\'now\') WHERE id = ?')
    .run(label, label, entity.id);
  return true;
}

export function dismissEntity(db: Database.Database, nameOrEmail: string, reason?: string): boolean {
  const entity = getEntity(db, nameOrEmail);
  if (!entity) return false;

  db.prepare('UPDATE entities SET user_dismissed = 1, updated_at = datetime(\'now\') WHERE id = ?')
    .run(entity.id);

  // Invalidate all edges involving this entity (temporal: preserve history, don't delete)
  db.prepare('UPDATE entity_edges SET invalid_at = datetime(\'now\'), updated_at = datetime(\'now\') WHERE (source_entity_id = ? OR target_entity_id = ?) AND invalid_at IS NULL')
    .run(entity.id, entity.id);

  db.prepare('INSERT OR IGNORE INTO dismissals (id, entity_id, reason, dismissed_at) VALUES (?, ?, ?, datetime(\'now\'))')
    .run(uuid(), entity.id, reason || 'user dismissed');
  return true;
}

export function dismissDomain(db: Database.Database, domain: string, reason?: string): number {
  // Dismiss all entities with this domain
  const result = db.prepare('UPDATE entities SET user_dismissed = 1, updated_at = datetime(\'now\') WHERE domain = ?')
    .run(domain);

  db.prepare('INSERT OR IGNORE INTO dismissals (id, domain, reason, dismissed_at) VALUES (?, ?, ?, datetime(\'now\'))')
    .run(uuid(), domain, reason || `domain dismissed: ${domain}`);

  return result.changes;
}

export function mergeEntities(db: Database.Database, fromName: string, toName: string): boolean {
  const fromEntity = getEntity(db, fromName);
  const toEntity = getEntity(db, toName);
  if (!fromEntity || !toEntity) return false;
  if (fromEntity.id === toEntity.id) return true; // already same

  // Move all mentions from source to target
  const mentions = db.prepare('SELECT * FROM entity_mentions WHERE entity_id = ?').all(fromEntity.id) as any[];
  for (const m of mentions) {
    try {
      db.prepare('INSERT OR IGNORE INTO entity_mentions (id, entity_id, knowledge_item_id, role, direction, mention_date, source_account) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(uuid(), toEntity.id, m.knowledge_item_id, m.role, m.direction, m.mention_date);
    } catch {}
  }

  // Temporal edge migration: invalidate source edges, create new ones pointing to target
  const sourceEdges = db.prepare(
    'SELECT * FROM entity_edges WHERE (source_entity_id = ? OR target_entity_id = ?) AND invalid_at IS NULL'
  ).all(fromEntity.id, fromEntity.id) as any[];

  for (const edge of sourceEdges) {
    // Invalidate the old edge
    db.prepare('UPDATE entity_edges SET invalid_at = datetime(\'now\'), updated_at = datetime(\'now\') WHERE id = ?')
      .run(edge.id);

    // Determine the new source/target (replace fromEntity with toEntity)
    const newSource = edge.source_entity_id === fromEntity.id ? toEntity.id : edge.source_entity_id;
    const newTarget = edge.target_entity_id === fromEntity.id ? toEntity.id : edge.target_entity_id;

    // Don't create self-referential edges
    if (newSource === newTarget) continue;

    // Canonical order for co_occurs edges
    const [a, b] = [newSource, newTarget].sort();

    // Check if target already has this edge
    const existingTarget = db.prepare(
      'SELECT id, co_occurrence_count, confidence FROM entity_edges WHERE source_entity_id = ? AND target_entity_id = ? AND edge_type = ? AND invalid_at IS NULL'
    ).get(a, b, edge.edge_type) as any;

    if (existingTarget) {
      // Merge counts and bump confidence
      const mergedCount = existingTarget.co_occurrence_count + edge.co_occurrence_count;
      const newConf = Math.min(1.0, (existingTarget.confidence || 0.5) + 0.1);
      db.prepare('UPDATE entity_edges SET co_occurrence_count = ?, confidence = ?, updated_at = datetime(\'now\') WHERE id = ?')
        .run(mergedCount, newConf, existingTarget.id);
    } else {
      db.prepare(
        'INSERT INTO entity_edges (id, source_entity_id, target_entity_id, edge_type, co_occurrence_count, confidence, valid_at, source_session, created_at) VALUES (?, ?, ?, ?, ?, ?, datetime(\'now\'), ?, datetime(\'now\'))'
      ).run(uuid(), a, b, edge.edge_type, edge.co_occurrence_count, edge.confidence || 0.5, `merge-${fromName}-into-${toName}`);
    }
  }

  // Move aliases
  db.prepare('UPDATE entity_aliases SET entity_id = ? WHERE entity_id = ?').run(toEntity.id, fromEntity.id);

  // Add source name as alias on target
  try {
    db.prepare('INSERT OR IGNORE INTO entity_aliases (id, entity_id, alias, alias_normalized, source) VALUES (?, ?, ?, ?, ?)')
      .run(uuid(), toEntity.id, fromEntity.canonical_name, normalizeName(fromEntity.canonical_name), 'merge');
  } catch {}

  // Copy email if target doesn't have one
  if (!toEntity.email && fromEntity.email) {
    db.prepare('UPDATE entities SET email = ?, domain = ? WHERE id = ?')
      .run(fromEntity.email, fromEntity.domain, toEntity.id);
  }

  // Delete source entity (CASCADE deletes old invalidated edges — that's fine, they're historical)
  db.prepare('DELETE FROM entities WHERE id = ?').run(fromEntity.id);

  return true;
}

// ── Seeding from user input ──────────────────────────────────

export function seedEntitiesFromUserInput(
  db: Database.Database,
  seeds: { employees?: string[]; partners?: string[]; projects?: string[] }
): { created: number } {
  let created = 0;

  const createOrLabel = (name: string, type: string, label: string) => {
    const existing = getEntity(db, name);
    if (existing) {
      db.prepare('UPDATE entities SET user_label = ?, relationship_type = ?, relationship_confidence = 1.0 WHERE id = ?')
        .run(label, label, existing.id);
    } else {
      const id = uuid();
      db.prepare(`INSERT INTO entities (id, type, canonical_name, relationship_type, relationship_confidence, user_label, created_at) VALUES (?, ?, ?, ?, 1.0, ?, datetime('now'))`)
        .run(id, type, name, label, label);
      db.prepare('INSERT INTO entity_aliases (id, entity_id, alias, alias_normalized, source) VALUES (?, ?, ?, ?, ?)')
        .run(uuid(), id, name, normalizeName(name), 'user_seed');
      created++;
    }
  };

  for (const emp of seeds.employees || []) createOrLabel(emp, 'person', 'employee');
  for (const partner of seeds.partners || []) createOrLabel(partner, 'person', 'partner');
  for (const proj of seeds.projects || []) createOrLabel(proj, 'project', 'project');

  return { created };
}

// ── Entity Graph Builder ─────────────────────────────────────

export function buildEntityGraph(
  db: Database.Database,
  options: { incremental?: boolean } = {}
): { entities: number; mentions: number; edges: number; merged: number } {
  const stats = { entities: 0, mentions: 0, edges: 0, merged: 0 };

  // Get all knowledge items (or incremental since last build)
  let items: any[];
  if (options.incremental) {
    const lastBuild = db.prepare("SELECT value FROM graph_state WHERE key = 'last_entity_build'").get() as any;
    const since = lastBuild?.value || '2000-01-01';
    items = db.prepare('SELECT * FROM knowledge_primary WHERE source_date > ? ORDER BY source_date ASC').all(since) as any[];
  } else {
    items = db.prepare('SELECT * FROM knowledge_primary ORDER BY source_date ASC').all() as any[];
  }

  console.log(`  Processing ${items.length} items for entities...`);

  // Build email→entity lookup from existing entities
  const emailMap = new Map<string, string>(); // email → entity_id
  const aliasMap = new Map<string, string>(); // normalized_name → entity_id
  const existingEntities = db.prepare('SELECT id, email, canonical_name FROM entities').all() as any[];
  for (const e of existingEntities) {
    if (e.email) emailMap.set(e.email.toLowerCase(), e.id);
    aliasMap.set(normalizeName(e.canonical_name), e.id);
  }

  // Also load all aliases
  const existingAliases = db.prepare('SELECT entity_id, alias_normalized FROM entity_aliases').all() as any[];
  for (const a of existingAliases) {
    aliasMap.set(a.alias_normalized, a.entity_id);
  }

  // Process each item
  const itemEntities = new Map<string, Set<string>>(); // item_id → set of entity_ids

  for (const item of items) {
    const contacts = parseJsonArray(item.contacts);
    const orgs = parseJsonArray(item.organizations);
    const meta = parseJsonObj(item.metadata);
    const entityIds = new Set<string>();

    // Extract email from metadata.last_from (Gmail items)
    let fromEmail: string | null = null;
    let fromName: string | null = null;
    if (meta.last_from) {
      const parsed = parseEmailFromHeader(meta.last_from);
      if (parsed) {
        fromEmail = parsed.email;
        fromName = parsed.name || null;
      }
    }

    // Process each contact name
    for (const contactName of contacts) {
      if (!contactName || contactName.length < 2) continue;

      const normalized = normalizeName(contactName);
      if (!normalized) continue;

      // Try to match to existing entity
      let entityId: string | null = null;

      // 1. Email match (if this contact matches the from email)
      if (fromEmail && fromName && normalizeName(fromName) === normalized) {
        entityId = emailMap.get(fromEmail) || null;
      }

      // 2. Alias/name match
      if (!entityId) {
        entityId = aliasMap.get(normalized) || null;
      }

      // 3. Create new entity
      if (!entityId) {
        entityId = uuid();
        const email = (fromName && normalizeName(fromName) === normalized) ? fromEmail : null;
        const domain = email ? extractDomain(email) : null;

        db.prepare(`INSERT OR IGNORE INTO entities (id, type, canonical_name, email, domain, first_seen_date, last_seen_date, created_at) VALUES (?, 'person', ?, ?, ?, ?, ?, datetime('now'))`)
          .run(entityId, contactName, email, domain, item.source_date, item.source_date);

        db.prepare('INSERT OR IGNORE INTO entity_aliases (id, entity_id, alias, alias_normalized, source) VALUES (?, ?, ?, ?, ?)')
          .run(uuid(), entityId, contactName, normalized, 'extraction');

        if (email) emailMap.set(email, entityId);
        aliasMap.set(normalized, entityId);
        stats.entities++;
      }

      // Create mention
      const direction = meta.waiting_on_user === false ? 'outbound' : (meta.waiting_on_user === true ? 'inbound' : null);
      try {
        db.prepare('INSERT OR IGNORE INTO entity_mentions (id, entity_id, knowledge_item_id, role, direction, mention_date, source_account) VALUES (?, ?, ?, ?, ?, ?, ?)')
          .run(uuid(), entityId, item.id, 'mentioned', direction, item.source_date);
        stats.mentions++;
      } catch {}

      // Update last_seen_date
      db.prepare('UPDATE entities SET last_seen_date = MAX(COALESCE(last_seen_date, ?), ?) WHERE id = ?')
        .run(item.source_date, item.source_date, entityId);

      entityIds.add(entityId);
    }

    // Process organizations
    for (const orgName of orgs) {
      if (!orgName || orgName.length < 2) continue;
      const normalized = normalizeName(orgName);
      if (!normalized) continue;

      let entityId = aliasMap.get(normalized) || null;
      if (!entityId) {
        entityId = uuid();
        db.prepare(`INSERT OR IGNORE INTO entities (id, type, canonical_name, first_seen_date, last_seen_date, created_at) VALUES (?, 'organization', ?, ?, ?, datetime('now'))`)
          .run(entityId, orgName, item.source_date, item.source_date);
        db.prepare('INSERT OR IGNORE INTO entity_aliases (id, entity_id, alias, alias_normalized, source) VALUES (?, ?, ?, ?, ?)')
          .run(uuid(), entityId, orgName, normalized, 'extraction');
        aliasMap.set(normalized, entityId);
        stats.entities++;
      }

      try {
        db.prepare('INSERT OR IGNORE INTO entity_mentions (id, entity_id, knowledge_item_id, role, direction, mention_date, source_account) VALUES (?, ?, ?, ?, ?, ?, ?)')
          .run(uuid(), entityId, item.id, 'mentioned', null, item.source_date);
        stats.mentions++;
      } catch {}

      entityIds.add(entityId);
    }

    // Store for co-occurrence edge building
    if (entityIds.size > 0) {
      itemEntities.set(item.id, entityIds);
    }

    // Progress
    if (items.indexOf(item) % 100 === 0) {
      process.stdout.write(`\r  Processed: ${items.indexOf(item)}/${items.length}`);
    }
  }
  console.log(`\r  Processed: ${items.length}/${items.length}`);

  // Build co-occurrence edges (temporal pattern: validity windows, confidence accumulation)
  console.log('  Building co-occurrence edges...');
  for (const [itemId, entityIds] of itemEntities) {
    const ids = Array.from(entityIds);
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const [a, b] = [ids[i], ids[j]].sort(); // canonical order
        try {
          // Only look at currently-valid edges (invalid_at IS NULL)
          const existing = db.prepare(
            'SELECT id, co_occurrence_count, confidence FROM entity_edges WHERE source_entity_id = ? AND target_entity_id = ? AND edge_type = ? AND invalid_at IS NULL'
          ).get(a, b, 'co_occurs') as any;

          if (existing) {
            // Re-observation: bump count and confidence (cap at 1.0)
            const newConfidence = Math.min(1.0, (existing.confidence || 0.5) + 0.1);
            db.prepare('UPDATE entity_edges SET co_occurrence_count = co_occurrence_count + 1, confidence = ?, updated_at = datetime(\'now\') WHERE id = ?')
              .run(newConfidence, existing.id);
          } else {
            const edgeId = uuid();
            db.prepare('INSERT INTO entity_edges (id, source_entity_id, target_entity_id, edge_type, co_occurrence_count, confidence, valid_at, source_session, created_at) VALUES (?, ?, ?, ?, 1, 0.5, datetime(\'now\'), ?, datetime(\'now\'))')
              .run(edgeId, a, b, 'co_occurs', `entity-build-${new Date().toISOString().slice(0, 10)}`);
            stats.edges++;
          }

          // Add evidence (link to current valid edge)
          db.prepare('INSERT OR IGNORE INTO edge_evidence (id, edge_id, knowledge_item_id, evidence_date) VALUES (?, (SELECT id FROM entity_edges WHERE source_entity_id = ? AND target_entity_id = ? AND edge_type = ? AND invalid_at IS NULL), ?, ?)')
            .run(uuid(), a, b, 'co_occurs', itemId, null);
        } catch {}
      }
    }
  }

  // Auto-merge entities with same email
  console.log('  Checking for email-based merges...');
  const emailGroups = db.prepare(
    'SELECT email, GROUP_CONCAT(id) as ids, COUNT(*) as cnt FROM entities WHERE email IS NOT NULL GROUP BY email HAVING cnt > 1'
  ).all() as any[];

  for (const group of emailGroups) {
    const ids = group.ids.split(',');
    const primary = ids[0];
    for (let i = 1; i < ids.length; i++) {
      const fromEntity = db.prepare('SELECT canonical_name FROM entities WHERE id = ?').get(ids[i]) as any;
      const toEntity = db.prepare('SELECT canonical_name FROM entities WHERE id = ?').get(primary) as any;
      if (fromEntity && toEntity) {
        mergeEntities(db, fromEntity.canonical_name, toEntity.canonical_name);
        stats.merged++;
      }
    }
  }

  // Update graph state
  const latestDate = items.length > 0 ? items[items.length - 1].source_date : new Date().toISOString();
  db.prepare("INSERT OR REPLACE INTO graph_state (key, value, updated_at) VALUES ('last_entity_build', ?, datetime('now'))")
    .run(latestDate);

  return stats;
}

// ── Entity Profile ───────────────────────────────────────────

export function getEntityProfile(db: Database.Database, nameOrEmail: string): any {
  const entity = getEntity(db, nameOrEmail);
  if (!entity) return null;

  // Get mention count and stats
  const mentionStats = db.prepare(`
    SELECT COUNT(*) as total,
      SUM(CASE WHEN direction = 'inbound' THEN 1 ELSE 0 END) as inbound,
      SUM(CASE WHEN direction = 'outbound' THEN 1 ELSE 0 END) as outbound,
      MIN(mention_date) as first_seen,
      MAX(mention_date) as last_seen
    FROM entity_mentions WHERE entity_id = ?
  `).get(entity.id) as any;

  // Get projects (from knowledge items this entity appears in)
  const projects = db.prepare(`
    SELECT DISTINCT k.project FROM knowledge_primary k
    JOIN entity_mentions em ON k.id = em.knowledge_item_id
    WHERE em.entity_id = ? AND k.project IS NOT NULL
  `).all(entity.id) as any[];

  // Get aliases
  const aliases = db.prepare('SELECT alias FROM entity_aliases WHERE entity_id = ?').all(entity.id) as any[];

  // Get recent items
  const recentItems = db.prepare(`
    SELECT k.id, k.title, k.source, k.source_date
    FROM knowledge_primary k
    JOIN entity_mentions em ON k.id = em.knowledge_item_id
    WHERE em.entity_id = ?
    ORDER BY k.source_date DESC LIMIT 5
  `).all(entity.id) as any[];

  // Get connected entities (co-occurrence) — only current edges
  const connected = db.prepare(`
    SELECT e.canonical_name, e.relationship_type, ee.co_occurrence_count
    FROM entity_edges ee
    JOIN entities e ON (
      CASE WHEN ee.source_entity_id = ? THEN ee.target_entity_id
           ELSE ee.source_entity_id END = e.id
    )
    WHERE (ee.source_entity_id = ? OR ee.target_entity_id = ?)
      AND ee.invalid_at IS NULL
      AND e.user_dismissed = 0
    ORDER BY ee.co_occurrence_count DESC LIMIT 10
  `).all(entity.id, entity.id, entity.id) as any[];

  // Get open commitments
  const commitments = db.prepare(`
    SELECT text, state, due_date FROM commitments
    WHERE (owner LIKE ? OR assigned_to LIKE ?)
      AND state IN ('active', 'overdue', 'detected')
  `).all(`%${entity.canonical_name}%`, `%${entity.canonical_name}%`) as any[];

  const daysSince = mentionStats.last_seen
    ? Math.floor((Date.now() - new Date(mentionStats.last_seen).getTime()) / 86400000)
    : null;

  return {
    ...entity,
    mention_count: mentionStats.total,
    inbound: mentionStats.inbound,
    outbound: mentionStats.outbound,
    days_since: daysSince,
    status: daysSince === null ? 'unknown' :
            daysSince <= 3 ? 'active' :
            daysSince <= 7 ? 'warm' :
            daysSince <= 14 ? 'cooling' :
            daysSince <= 30 ? 'cold' : 'dormant',
    projects: projects.map(p => p.project),
    aliases: aliases.map(a => a.alias),
    recent_items: recentItems,
    connected: connected,
    commitments: commitments,
  };
}

// ── Living Entity Profile ────────────────────────────────────
// Assembles COMPLETE intelligence dossier for an entity from ALL data sources.
// Pure SQL — no LLM calls. Theory of mind comes from graph_state (intelligence cycle).

export function getLivingProfile(db: Database.Database, nameOrEmail: string): any {
  // Resolve entity — fuzzy matching with priority: exact > name-like > email-like
  let entity = getEntity(db, nameOrEmail);
  if (!entity) {
    // Priority 1: canonical_name contains the search term (NOT email addresses)
    entity = db.prepare(
      "SELECT * FROM entities WHERE canonical_name LIKE ? AND canonical_name NOT LIKE '%@%' AND user_dismissed = 0 ORDER BY last_seen_date DESC LIMIT 1"
    ).get(`%${nameOrEmail}%`) as any;
  }
  if (!entity) {
    // Priority 2: first name match (search "Costas" matches "Costas Manganiotis")
    entity = db.prepare(
      "SELECT * FROM entities WHERE canonical_name LIKE ? AND canonical_name NOT LIKE '%@%' AND user_dismissed = 0 ORDER BY last_seen_date DESC LIMIT 1"
    ).get(`${nameOrEmail}%`) as any;
  }
  if (!entity) {
    // Priority 3: any match including emails
    entity = db.prepare(
      'SELECT * FROM entities WHERE (canonical_name LIKE ? OR email LIKE ?) AND user_dismissed = 0 ORDER BY last_seen_date DESC LIMIT 1'
    ).get(`%${nameOrEmail}%`, `%${nameOrEmail}%`) as any;
  }
  if (!entity) return null;

  // a) Entity profile (communication nature, reply expectation)
  const profile = db.prepare(`
    SELECT communication_nature, reply_expectation, importance_to_business,
           importance_evidence, relationship_evidence, alert_verdict
    FROM entity_profiles WHERE entity_id = ?
  `).get(entity.id) as any;

  // b) Communication history — last 10 knowledge items
  const recentComms = db.prepare(`
    SELECT k.title, k.source, k.source_date, k.summary, k.project
    FROM knowledge_primary k
    JOIN entity_mentions em ON k.id = em.knowledge_item_id
    WHERE em.entity_id = ?
    ORDER BY k.source_date DESC LIMIT 10
  `).all(entity.id) as any[];

  // c) Communication trend: this week vs prior 3 weeks baseline
  const trend = db.prepare(`
    SELECT
      COUNT(CASE WHEN k.source_date >= datetime('now', '-7 days') THEN 1 END) as this_week,
      COUNT(CASE WHEN k.source_date >= datetime('now', '-28 days') AND k.source_date < datetime('now', '-7 days') THEN 1 END) as prev_3weeks
    FROM entity_mentions em
    JOIN knowledge k ON em.knowledge_item_id = k.id
    WHERE em.entity_id = ?
      AND k.source_date >= datetime('now', '-28 days')
  `).get(entity.id) as any;

  const thisWeek = trend?.this_week || 0;
  const baselinePerWeek = Math.max((trend?.prev_3weeks || 0) / 3, 1);
  const ratio = thisWeek / baselinePerWeek;

  const communicationTrend = ratio > 2 ? 'surging' : ratio >= 0.5 ? 'active' : ratio >= 0.25 ? 'cooling' : 'cold';
  const trendDetail = `${thisWeek} mentions this week vs ${baselinePerWeek.toFixed(1)}/week baseline (${ratio.toFixed(1)}x)`;

  // d) Relationship health: (mentions_this_week / baseline) * 100, capped at 100
  const relationshipHealth = Math.min(100, Math.round(ratio * 100));

  // e) Theory of mind from graph_state
  let theoryOfMind: any = null;
  const theoriesRaw = (db.prepare(
    "SELECT value FROM graph_state WHERE key = 'theories_of_mind'"
  ).get() as any)?.value;

  if (theoriesRaw) {
    try {
      const theories = JSON.parse(theoriesRaw);
      theoryOfMind = theories.find((t: any) =>
        t.entity?.toLowerCase().includes(entity.canonical_name.toLowerCase()) ||
        entity.canonical_name.toLowerCase().includes(t.entity?.toLowerCase())
      );
    } catch {}
  }

  // f) Active commitments
  const commitments = db.prepare(`
    SELECT text, state, due_date FROM commitments
    WHERE (owner LIKE ? OR assigned_to LIKE ?)
      AND state IN ('active', 'overdue', 'detected')
  `).all(`%${entity.canonical_name}%`, `%${entity.canonical_name}%`) as any[];

  // g) Projects involved
  const projects = db.prepare(`
    SELECT DISTINCT k.project FROM knowledge_primary k
    JOIN entity_mentions em ON k.id = em.knowledge_item_id
    WHERE em.entity_id = ? AND k.project IS NOT NULL
  `).all(entity.id) as any[];

  // h) Last interaction
  const lastInteraction = db.prepare(`
    SELECT MAX(k.source_date) as last_date
    FROM knowledge_primary k
    JOIN entity_mentions em ON k.id = em.knowledge_item_id
    WHERE em.entity_id = ?
  `).get(entity.id) as any;

  const lastDate = lastInteraction?.last_date;
  const daysSinceContact = lastDate
    ? Math.floor((Date.now() - new Date(lastDate).getTime()) / 86400000)
    : null;

  // i) Tone analysis — extract keywords from recent summaries
  const toneKeywords: string[] = [];
  const toneWords: Record<string, string[]> = {
    urgent: ['urgent', 'asap', 'immediately', 'critical', 'deadline'],
    positive: ['excited', 'great', 'pleased', 'happy', 'looking forward', 'progress', 'agreed'],
    negative: ['concerned', 'frustrated', 'disappointed', 'problem', 'issue', 'delay', 'risk'],
    formal: ['proposal', 'agreement', 'contract', 'terms', 'compliance'],
    collaborative: ['partnership', 'together', 'collaborate', 'aligned', 'synergy'],
  };
  const recentText = recentComms.slice(0, 5).map(c => (c.summary || '').toLowerCase()).join(' ');
  for (const [tone, words] of Object.entries(toneWords)) {
    if (words.some(w => recentText.includes(w))) toneKeywords.push(tone);
  }

  // j) Risk signals — auto-detect from data patterns
  const riskSignals: string[] = [];
  if (ratio > 3) riskSignals.push(`${ratio.toFixed(1)}x communication surge may indicate urgency or escalation`);
  if (ratio < 0.25 && (trend?.prev_3weeks || 0) > 3) riskSignals.push('Significant drop in communication — possible disengagement');
  const overdueCommitments = commitments.filter(c => c.state === 'overdue');
  if (overdueCommitments.length > 0) riskSignals.push(`${overdueCommitments.length} overdue commitment(s) — potential friction`);
  if (daysSinceContact !== null && daysSinceContact > 14 && commitments.length > 0) {
    riskSignals.push(`${daysSinceContact} days since contact with active commitments — follow-up needed`);
  }

  return {
    name: entity.canonical_name,
    role: entity.user_label || entity.relationship_type || 'unknown',
    email: entity.email,
    relationship_health: relationshipHealth,
    communication_trend: communicationTrend,
    trend_detail: trendDetail,

    profile: {
      communication_nature: profile?.communication_nature || 'unknown',
      reply_expectation: profile?.reply_expectation || 'unknown',
      importance_to_business: profile?.importance_to_business || 'unknown',
      importance_evidence: profile?.importance_evidence || '',
      alert_verdict: profile?.alert_verdict || 'pending',
    },

    theory_of_mind: theoryOfMind ? {
      knows: theoryOfMind.knows || [],
      wants: theoryOfMind.wants || [],
      constraints: theoryOfMind.constraints || [],
      behavior_hypothesis: theoryOfMind.behavior_hypothesis || '',
      likely_next_move: theoryOfMind.likely_next_move || '',
    } : null,

    recent_communications: recentComms.map(c => ({
      title: c.title,
      source: c.source,
      date: c.source_date,
      summary: (c.summary || '').slice(0, 300),
    })),

    active_commitments: commitments.map(c => ({
      text: c.text,
      state: c.state,
      due_date: c.due_date,
    })),

    projects: projects.map(p => p.project),
    tone: toneKeywords,

    last_interaction: lastDate || null,
    days_since_contact: daysSinceContact,

    risk_signals: riskSignals,
  };
}

// ── Top Entities (mini-profiles) ─────────────────────────────

export function getTopEntities(db: Database.Database, limit: number = 15): any[] {
  const rows = db.prepare(`
    SELECT e.id, e.canonical_name, e.user_label, e.relationship_type, e.email,
      COUNT(em.id) as recent_mentions,
      MAX(k.source_date) as last_interaction
    FROM entities e
    JOIN entity_mentions em ON em.entity_id = e.id
    JOIN knowledge k ON em.knowledge_item_id = k.id
    WHERE e.user_dismissed = 0
      AND e.canonical_name NOT LIKE '%Zach%Stock%'
      AND k.source_date >= datetime('now', '-30 days')
    GROUP BY e.id
    ORDER BY recent_mentions DESC
    LIMIT ?
  `).all(limit) as any[];

  return rows.map(r => {
    // Mini trend calculation
    const trend = db.prepare(`
      SELECT
        COUNT(CASE WHEN k.source_date >= datetime('now', '-7 days') THEN 1 END) as this_week,
        COUNT(CASE WHEN k.source_date >= datetime('now', '-28 days') AND k.source_date < datetime('now', '-7 days') THEN 1 END) as prev_3weeks
      FROM entity_mentions em
      JOIN knowledge k ON em.knowledge_item_id = k.id
      WHERE em.entity_id = ? AND k.source_date >= datetime('now', '-28 days')
    `).get(r.id) as any;

    const thisWeek = trend?.this_week || 0;
    const baselinePerWeek = Math.max((trend?.prev_3weeks || 0) / 3, 1);
    const ratio = thisWeek / baselinePerWeek;
    const health = Math.min(100, Math.round(ratio * 100));
    const commTrend = ratio > 2 ? 'surging' : ratio >= 0.5 ? 'active' : ratio >= 0.25 ? 'cooling' : 'cold';

    const lastDate = r.last_interaction;
    const daysSince = lastDate
      ? Math.floor((Date.now() - new Date(lastDate).getTime()) / 86400000)
      : null;

    return {
      name: r.canonical_name,
      role: r.user_label || r.relationship_type || 'unknown',
      recent_mentions: r.recent_mentions,
      relationship_health: health,
      communication_trend: commTrend,
      last_interaction: lastDate,
      days_since_contact: daysSince,
    };
  });
}

// ── Implicit Learning ────────────────────────────────────────

export function recordSignal(db: Database.Database, entityName: string, signalType: string): void {
  const entity = getEntity(db, entityName);
  if (!entity) return;

  const existing = db.prepare(
    'SELECT id, count FROM entity_signals WHERE entity_id = ? AND signal_type = ?'
  ).get(entity.id, signalType) as any;

  if (existing) {
    db.prepare('UPDATE entity_signals SET count = count + 1, last_seen = datetime(\'now\') WHERE id = ?')
      .run(existing.id);
  } else {
    db.prepare('INSERT INTO entity_signals (id, entity_id, signal_type, count, last_seen) VALUES (?, ?, ?, 1, datetime(\'now\'))')
      .run(uuid(), entity.id, signalType);
  }

  // Auto-actions based on signal accumulation
  if (signalType === 'alert_ignored' && (existing?.count || 0) + 1 >= 3) {
    // Auto-demote after 3 ignores
    db.prepare('UPDATE entities SET relationship_type = \'noise\', relationship_confidence = 0.6, updated_at = datetime(\'now\') WHERE id = ? AND user_label IS NULL')
      .run(entity.id);
  }

  if (signalType === 'alert_acted' && (existing?.count || 0) + 1 >= 5) {
    // Auto-elevate after 5 actions
    if (!entity.relationship_type || entity.relationship_type === 'unknown') {
      db.prepare('UPDATE entities SET relationship_type = \'partner\', relationship_confidence = 0.7, updated_at = datetime(\'now\') WHERE id = ? AND user_label IS NULL')
        .run(entity.id);
    }
  }
}

export function getSignals(db: Database.Database, entityName: string): any[] {
  const entity = getEntity(db, entityName);
  if (!entity) return [];
  return db.prepare('SELECT signal_type, count, last_seen FROM entity_signals WHERE entity_id = ?').all(entity.id) as any[];
}

// ── Communication Pattern Analysis ───────────────────────────

export interface CommunicationPattern {
  entity_name: string;
  total_interactions: number;
  inbound: number;
  outbound: number;
  avg_gap_days: number;        // average days between interactions
  last_interaction: string;
  days_since: number;
  interaction_frequency: 'daily' | 'weekly' | 'biweekly' | 'monthly' | 'quarterly' | 'rare';
  trend: 'increasing' | 'stable' | 'decreasing' | 'stalled';
  sources: string[];
  projects: string[];
  peak_day?: string;           // day of week with most interactions
}

export function analyzeEntityPattern(db: Database.Database, nameOrEmail: string): CommunicationPattern | null {
  const entity = getEntity(db, nameOrEmail);
  if (!entity) return null;

  // Get all mentions with dates
  const mentions = db.prepare(`
    SELECT em.direction, em.mention_date, k.source, k.project
    FROM entity_mentions em
    JOIN knowledge_primary k ON em.knowledge_item_id = k.id
    WHERE em.entity_id = ? AND em.mention_date IS NOT NULL
    ORDER BY em.mention_date ASC
  `).all(entity.id) as any[];

  if (mentions.length < 2) return null;

  const inbound = mentions.filter((m: any) => m.direction === 'inbound').length;
  const outbound = mentions.filter((m: any) => m.direction === 'outbound').length;
  const sources = [...new Set(mentions.map((m: any) => m.source))];
  const projects = [...new Set(mentions.filter((m: any) => m.project).map((m: any) => m.project))];

  // Calculate average gap between interactions
  const dates = mentions.map((m: any) => new Date(m.mention_date).getTime()).sort();
  const gaps: number[] = [];
  for (let i = 1; i < dates.length; i++) {
    gaps.push((dates[i] - dates[i - 1]) / 86400000);
  }
  const avgGap = gaps.length > 0 ? gaps.reduce((a, b) => a + b, 0) / gaps.length : 0;

  // Frequency classification
  let frequency: CommunicationPattern['interaction_frequency'];
  if (avgGap <= 1.5) frequency = 'daily';
  else if (avgGap <= 7) frequency = 'weekly';
  else if (avgGap <= 14) frequency = 'biweekly';
  else if (avgGap <= 30) frequency = 'monthly';
  else if (avgGap <= 90) frequency = 'quarterly';
  else frequency = 'rare';

  // Trend: compare recent 14d activity to previous 14d
  const now = Date.now();
  const recent = mentions.filter((m: any) => now - new Date(m.mention_date).getTime() < 14 * 86400000).length;
  const previous = mentions.filter((m: any) => {
    const t = now - new Date(m.mention_date).getTime();
    return t >= 14 * 86400000 && t < 28 * 86400000;
  }).length;

  let trend: CommunicationPattern['trend'];
  if (recent === 0) trend = 'stalled';
  else if (recent > previous * 1.5) trend = 'increasing';
  else if (recent < previous * 0.5) trend = 'decreasing';
  else trend = 'stable';

  // Peak day of week
  const dayCount: Record<string, number> = {};
  const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  for (const m of mentions) {
    const day = dayNames[new Date(m.mention_date).getDay()];
    dayCount[day] = (dayCount[day] || 0) + 1;
  }
  const peakDay = Object.entries(dayCount).sort((a, b) => b[1] - a[1])[0]?.[0];

  const lastMention = mentions[mentions.length - 1];
  const daysSince = Math.floor((now - new Date(lastMention.mention_date).getTime()) / 86400000);

  return {
    entity_name: entity.canonical_name,
    total_interactions: mentions.length,
    inbound,
    outbound,
    avg_gap_days: Math.round(avgGap * 10) / 10,
    last_interaction: lastMention.mention_date,
    days_since: daysSince,
    interaction_frequency: frequency,
    trend,
    sources,
    projects,
    peak_day: peakDay,
  };
}

/**
 * Get communication patterns for all active, non-dismissed entities.
 */
export function getTopPatterns(db: Database.Database, limit: number = 20): CommunicationPattern[] {
  const entities = db.prepare(`
    SELECT e.canonical_name FROM entities e
    LEFT JOIN entity_mentions em ON e.id = em.entity_id
    WHERE e.type = 'person' AND e.user_dismissed = 0 AND e.canonical_name != 'Zach Stock'
    GROUP BY e.id HAVING COUNT(em.id) >= 5
    ORDER BY COUNT(em.id) DESC LIMIT ?
  `).all(limit) as any[];

  return entities
    .map((e: any) => analyzeEntityPattern(db, e.canonical_name))
    .filter(Boolean) as CommunicationPattern[];
}

// ── Entity Understanding Builder ─────────────────────────────
// Analyzes communication DATA to build rich understanding profiles.
// No LLM. Just pattern recognition from what the emails actually are.

export interface EntityUnderstanding {
  entity_id: string;
  entity_name: string;
  communication_nature: 'transactional' | 'relational' | 'strategic' | 'informational' | 'spam' | 'unknown';
  reply_expectation: 'never' | 'rarely' | 'sometimes' | 'usually' | 'always' | 'unknown';
  email_types: string[];
  importance_to_business: 'critical' | 'high' | 'medium' | 'low' | 'none' | 'unknown';
  importance_evidence: string;
  relationship_evidence: string;
  alert_verdict: 'surface' | 'suppress' | 'pending';
  verdict_reasoning: string;
  verdict_confidence: number;
}

// Patterns that indicate transactional/informational emails (no reply needed)
const TRANSACTIONAL_TITLE_PATTERNS = [
  { pattern: /\binvoice\b/i, type: 'invoice' },
  { pattern: /\bpayment\b/i, type: 'payment' },
  { pattern: /\breceipt\b/i, type: 'receipt' },
  { pattern: /\bpolicy\s*(issued|delivered|attached|review)\b/i, type: 'policy_delivery' },
  { pattern: /\bsubmission\s*acknowledged\b/i, type: 'acknowledgment' },
  { pattern: /\backnowledge(d|ment)\b/i, type: 'acknowledgment' },
  { pattern: /\bconfirmation\b/i, type: 'confirmation' },
  { pattern: /\bnotification\b/i, type: 'notification' },
  { pattern: /\brenewal\s*(notice|reminder)\b/i, type: 'renewal_notice' },
  { pattern: /\bcertificate\b.*\b(issued|attached)\b/i, type: 'certificate' },
  { pattern: /\bstatement\b/i, type: 'statement' },
  { pattern: /\breport\b.*\b(attached|enclosed)\b/i, type: 'report_delivery' },
];

const RELATIONAL_TITLE_PATTERNS = [
  { pattern: /\bmeeting\b|\bschedule\b|\bcall\b/i, type: 'meeting_request' },
  { pattern: /\bquestion\b|\basking\b|\bneed\b.*\byour\b/i, type: 'question' },
  { pattern: /\bproposal\b|\bopportunity\b/i, type: 'proposal' },
  { pattern: /\bfollow\s*up\b.*\b(on|regarding|re)\b/i, type: 'follow_up' },
  { pattern: /\bintro(duction)?\b/i, type: 'introduction' },
  { pattern: /\bdiscuss(ion)?\b|\bcatch\s*up\b/i, type: 'discussion' },
  { pattern: /\bdecision\b|\bapproval\b|\bsign\s*off\b/i, type: 'decision_needed' },
];

const SPAM_TITLE_PATTERNS = [
  { pattern: /cold outreach/i, type: 'cold_outreach' },
  { pattern: /sales (outreach|email|pitch)/i, type: 'sales_pitch' },
  { pattern: /unsolicited/i, type: 'unsolicited' },
  { pattern: /\boffer(ing)?\b.*\b(services|solution)\b/i, type: 'service_offer' },
];

export function buildEntityUnderstanding(db: Database.Database, entityId: string): EntityUnderstanding | null {
  const entity = db.prepare('SELECT * FROM entities WHERE id = ?').get(entityId) as any;
  if (!entity) return null;

  // Get ALL items involving this entity
  const items = db.prepare(`
    SELECT k.id, k.title, k.summary, k.source, k.source_date, k.tags, k.metadata,
           em.direction, em.role
    FROM knowledge_primary k
    JOIN entity_mentions em ON k.id = em.knowledge_item_id
    WHERE em.entity_id = ?
    ORDER BY k.source_date ASC
  `).all(entityId) as any[];

  if (items.length === 0) {
    return {
      entity_id: entityId,
      entity_name: entity.canonical_name,
      communication_nature: 'unknown',
      reply_expectation: 'unknown',
      email_types: [],
      importance_to_business: 'unknown',
      importance_evidence: 'No communication history',
      relationship_evidence: 'No data',
      alert_verdict: 'suppress',
      verdict_reasoning: 'No communication history — nothing to alert on',
      verdict_confidence: 0.9,
    };
  }

  // ── Classify each email by type ────────────────────────────
  const emailTypes = new Map<string, number>();
  let transactionalCount = 0;
  let relationalCount = 0;
  let spamCount = 0;
  let inboundCount = 0;
  let outboundCount = 0;

  for (const item of items) {
    const title = item.title || '';
    const tags = parseJsonArray(typeof item.tags === 'string' ? item.tags : JSON.stringify(item.tags || []));
    const meta = parseJsonObj(typeof item.metadata === 'string' ? item.metadata : JSON.stringify(item.metadata || {}));

    if (item.direction === 'inbound') inboundCount++;
    if (item.direction === 'outbound') outboundCount++;

    // Check title patterns
    for (const p of TRANSACTIONAL_TITLE_PATTERNS) {
      if (p.pattern.test(title)) {
        emailTypes.set(p.type, (emailTypes.get(p.type) || 0) + 1);
        transactionalCount++;
      }
    }
    for (const p of RELATIONAL_TITLE_PATTERNS) {
      if (p.pattern.test(title)) {
        emailTypes.set(p.type, (emailTypes.get(p.type) || 0) + 1);
        relationalCount++;
      }
    }
    for (const p of SPAM_TITLE_PATTERNS) {
      if (p.pattern.test(title)) {
        emailTypes.set(p.type, (emailTypes.get(p.type) || 0) + 1);
        spamCount++;
      }
    }

    // Also check tags for invoice/billing patterns
    if (tags.some((t: string) => /invoice|billing|payment|accounts.payable/i.test(t))) {
      emailTypes.set('invoice', (emailTypes.get('invoice') || 0) + 1);
      transactionalCount++;
    }
  }

  const typeList = [...emailTypes.entries()].sort((a, b) => b[1] - a[1]).map(([t, c]) => t);

  // ── Determine communication nature ─────────────────────────
  let nature = 'unknown' as EntityUnderstanding['communication_nature'];
  if (spamCount > items.length * 0.5) {
    nature = 'spam';
  } else if (transactionalCount > items.length * 0.5) {
    nature = 'transactional';
  } else if (relationalCount > items.length * 0.3) {
    nature = 'relational';
  } else if (transactionalCount > 0 && relationalCount === 0) {
    nature = 'transactional';
  } else if (items.length <= 2 && spamCount === 0) {
    nature = 'unknown'; // too little data
  }

  // ── Determine reply expectation ────────────────────────────
  let replyExpectation: EntityUnderstanding['reply_expectation'] = 'unknown';
  if (nature === 'transactional') replyExpectation = 'rarely';
  if (nature === 'spam') replyExpectation = 'never';
  if (nature === 'informational') replyExpectation = 'never';

  // If this person sends questions, proposals, meeting requests → replies expected
  if (emailTypes.has('question') || emailTypes.has('decision_needed')) {
    replyExpectation = 'usually';
  } else if (emailTypes.has('meeting_request') || emailTypes.has('proposal') || emailTypes.has('introduction')) {
    replyExpectation = 'sometimes';
  }

  // ── Infer relationship from patterns ───────────────────────
  let relEvidence = '';

  // Sends invoices TO user → vendor
  if (emailTypes.has('invoice') || emailTypes.has('payment')) {
    relEvidence += `Sends invoices/billing (${emailTypes.get('invoice') || emailTypes.get('payment')}x). `;
  }
  // Issues policies → carrier/underwriter
  if (emailTypes.has('policy_delivery') || emailTypes.has('certificate')) {
    relEvidence += 'Issues policies/certificates. ';
  }
  // Acknowledges submissions → carrier
  if (emailTypes.has('acknowledgment')) {
    relEvidence += 'Acknowledges submissions. ';
  }
  // Sends proposals → potential partner/vendor
  if (emailTypes.has('proposal') || emailTypes.has('introduction')) {
    relEvidence += 'Sends proposals/introductions. ';
  }
  // Domain-based inference
  if (entity.domain) {
    relEvidence += `Domain: ${entity.domain}. `;
  }

  // Inbound/outbound ratio
  if (inboundCount > 0 || outboundCount > 0) {
    relEvidence += `Communication: ${inboundCount} inbound, ${outboundCount} outbound. `;
  }

  // ── Business importance ────────────────────────────────────
  let importance = 'unknown' as EntityUnderstanding['importance_to_business'];
  let importEvidence = '';

  const userLabel = entity.user_label;
  if (userLabel === 'partner' || userLabel === 'client') {
    importance = 'high';
    importEvidence = `User labeled as ${userLabel}. `;
  } else if (userLabel === 'advisor') {
    importance = 'medium';
    importEvidence = 'User labeled as advisor. ';
  } else if (userLabel === 'employee') {
    importance = 'medium';
    importEvidence = 'Employee — operational, not external. ';
  } else if (userLabel === 'vendor') {
    importance = 'low';
    importEvidence = 'Vendor — service provider. ';
  } else if (nature === 'transactional') {
    importance = 'low';
    importEvidence = 'Transactional communications only. ';
  } else if (nature === 'spam') {
    importance = 'none';
    importEvidence = 'Spam/cold outreach. ';
  } else if (items.length >= 10 && relationalCount > 0) {
    importance = 'medium';
    importEvidence = `${items.length} interactions with relational content. `;
  }

  // ── Alert verdict ──────────────────────────────────────────
  let verdict: EntityUnderstanding['alert_verdict'] = 'pending';
  let verdictReasoning = '';
  let verdictConfidence = 0.5;

  // Check open threads
  const openThreads = items.filter(i => {
    const tags = parseJsonArray(typeof i.tags === 'string' ? i.tags : JSON.stringify(i.tags || []));
    return tags.includes('awaiting_reply');
  });

  if (openThreads.length === 0) {
    verdict = 'suppress';
    verdictReasoning = 'No open threads.';
    verdictConfidence = 1.0;
  } else if (nature === 'spam') {
    verdict = 'suppress';
    verdictReasoning = 'Spam/cold outreach — never surface.';
    verdictConfidence = 0.95;
  } else if (nature === 'transactional' && replyExpectation === 'rarely') {
    verdict = 'suppress';
    verdictReasoning = `Transactional relationship (${typeList.slice(0, 3).join(', ')}). These emails don't require replies.`;
    verdictConfidence = 0.85;
  } else if (importance === 'high' || importance === 'critical') {
    verdict = 'surface';
    verdictReasoning = `High importance ${userLabel || 'relationship'} with ${openThreads.length} open thread(s).`;
    verdictConfidence = 0.8;
  } else if (nature === 'relational' && items.length >= 5) {
    verdict = 'surface';
    verdictReasoning = `Active relational contact with ${openThreads.length} open thread(s).`;
    verdictConfidence = 0.65;
  } else if (importance === 'low' || importance === 'none') {
    verdict = 'suppress';
    verdictReasoning = `Low importance, ${nature} communication. Not worth surfacing.`;
    verdictConfidence = 0.75;
  }

  return {
    entity_id: entityId,
    entity_name: entity.canonical_name,
    communication_nature: nature,
    reply_expectation: replyExpectation,
    email_types: typeList,
    importance_to_business: importance,
    importance_evidence: importEvidence.trim(),
    relationship_evidence: relEvidence.trim(),
    alert_verdict: verdict,
    verdict_reasoning: verdictReasoning,
    verdict_confidence: verdictConfidence,
  };
}

/**
 * Build understanding profiles for all entities with open threads.
 * Stores results in entity_profiles table for real-time alert lookup.
 */
export function buildAllEntityProfiles(db: Database.Database): { profiled: number; surface: number; suppress: number } {
  const stats = { profiled: 0, surface: 0, suppress: 0 };

  // Get all entities that have awaiting_reply items
  const entitiesWithOpenThreads = db.prepare(`
    SELECT DISTINCT em.entity_id
    FROM entity_mentions em
    JOIN knowledge_primary k ON em.knowledge_item_id = k.id
    WHERE k.tags LIKE '%awaiting_reply%'
  `).all() as any[];

  for (const row of entitiesWithOpenThreads) {
    // Don't overwrite user-set profiles
    const existing = db.prepare(
      'SELECT user_override FROM entity_profiles WHERE entity_id = ?'
    ).get(row.entity_id) as any;
    if (existing?.user_override) continue;

    const understanding = buildEntityUnderstanding(db, row.entity_id);
    if (!understanding) continue;

    db.prepare(`
      INSERT INTO entity_profiles (entity_id, communication_nature, reply_expectation, email_types,
        importance_to_business, importance_evidence, relationship_evidence,
        alert_verdict, verdict_reasoning, verdict_confidence, last_verified_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
      ON CONFLICT(entity_id) DO UPDATE SET
        communication_nature = excluded.communication_nature,
        reply_expectation = excluded.reply_expectation,
        email_types = excluded.email_types,
        importance_to_business = excluded.importance_to_business,
        importance_evidence = excluded.importance_evidence,
        relationship_evidence = excluded.relationship_evidence,
        alert_verdict = excluded.alert_verdict,
        verdict_reasoning = excluded.verdict_reasoning,
        verdict_confidence = excluded.verdict_confidence,
        last_verified_at = excluded.last_verified_at,
        updated_at = excluded.updated_at
    `).run(
      understanding.entity_id,
      understanding.communication_nature,
      understanding.reply_expectation,
      JSON.stringify(understanding.email_types),
      understanding.importance_to_business,
      understanding.importance_evidence,
      understanding.relationship_evidence,
      understanding.alert_verdict,
      understanding.verdict_reasoning,
      understanding.verdict_confidence,
    );

    stats.profiled++;
    if (understanding.alert_verdict === 'surface') stats.surface++;
    if (understanding.alert_verdict === 'suppress') stats.suppress++;
  }

  return stats;
}

// ── Relationship Momentum Scoring ─────────────────────────────
// Computes weekly interaction velocity for each active person entity.
// Classifies as ACCELERATING, DECELERATING, STEADY, or COLD.
// Stores results in graph_state key 'relationship_momentum'.

export interface RelationshipMomentum {
  entity_id: string;
  canonical_name: string;
  week1: number;  // items in last 7 days
  week2: number;  // items 8-14 days ago
  week3: number;  // items 15-21 days ago
  week4: number;  // items 22-28 days ago
  total: number;
  trend: 'accelerating' | 'decelerating' | 'steady' | 'cold' | 'new_burst';
}

export function computeRelationshipMomentum(db: Database.Database): RelationshipMomentum[] {
  const rows = db.prepare(`
    SELECT e.canonical_name, e.id,
      SUM(CASE WHEN k.source_date >= datetime('now', '-7 days') THEN 1 ELSE 0 END) as week1,
      SUM(CASE WHEN k.source_date >= datetime('now', '-14 days') AND k.source_date < datetime('now', '-7 days') THEN 1 ELSE 0 END) as week2,
      SUM(CASE WHEN k.source_date >= datetime('now', '-21 days') AND k.source_date < datetime('now', '-14 days') THEN 1 ELSE 0 END) as week3,
      SUM(CASE WHEN k.source_date >= datetime('now', '-28 days') AND k.source_date < datetime('now', '-21 days') THEN 1 ELSE 0 END) as week4
    FROM entities e
    JOIN entity_mentions em ON e.id = em.entity_id
    JOIN knowledge_primary k ON em.knowledge_item_id = k.id
    WHERE e.user_dismissed = 0 AND e.type = 'person'
    GROUP BY e.id
    HAVING (week1 + week2 + week3 + week4) > 0
  `).all() as any[];

  const results: RelationshipMomentum[] = rows.map((r: any) => {
    const w1 = r.week1 || 0;
    const w2 = r.week2 || 0;
    const w3 = r.week3 || 0;
    const w4 = r.week4 || 0;
    const total = w1 + w2 + w3 + w4;

    let trend: RelationshipMomentum['trend'];
    if (w1 === 0 && (w2 > 0 || w3 > 0)) {
      trend = 'cold';              // was active, went silent
    } else if (w1 > 0 && w2 === 0 && w3 === 0) {
      trend = 'new_burst';         // sudden new activity
    } else if (w1 > w2 && w2 >= w3) {
      trend = 'accelerating';      // increasing week over week
    } else if (w1 < w2 && w2 <= w3) {
      trend = 'decelerating';      // decreasing week over week
    } else {
      trend = 'steady';
    }

    return {
      entity_id: r.id,
      canonical_name: r.canonical_name,
      week1: w1, week2: w2, week3: w3, week4: w4,
      total,
      trend,
    };
  });

  // Sort: accelerating first, then new_burst, cold, decelerating, steady
  const trendOrder: Record<string, number> = { accelerating: 0, new_burst: 1, cold: 2, decelerating: 3, steady: 4 };
  results.sort((a, b) => (trendOrder[a.trend] ?? 5) - (trendOrder[b.trend] ?? 5) || b.total - a.total);

  // Store in graph_state
  db.prepare(`
    INSERT OR REPLACE INTO graph_state (key, value, updated_at)
    VALUES ('relationship_momentum', ?, datetime('now'))
  `).run(JSON.stringify(results));

  return results;
}

// ── Helpers ──────────────────────────────────────────────────

function parseJsonArray(val: any): string[] {
  if (Array.isArray(val)) return val;
  if (typeof val === 'string') {
    try { return JSON.parse(val); } catch {}
  }
  return [];
}

function parseJsonObj(val: any): any {
  if (val && typeof val === 'object' && !Array.isArray(val)) return val;
  if (typeof val === 'string') {
    try { return JSON.parse(val); } catch {}
  }
  return {};
}
