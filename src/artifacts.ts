import type Database from 'better-sqlite3';
import { v4 as uuid } from 'uuid';
import { generateEmbedding } from './embedding.js';
import { getConfig } from './db.js';

// ============================================================
// Artifact Management — versioned, full-content, cross-project
// ============================================================

export interface Artifact {
  id: string;
  identifier: string;
  title: string;
  type: string;
  version: number;
  is_latest: number;
  content: string;
  content_length: number;
  conversation_uuid: string | null;
  conversation_name: string | null;
  project: string | null;
  tags: string;
  created_at: string;
}

/**
 * Store or update an artifact. Handles version chain automatically.
 */
export function storeArtifact(
  db: Database.Database,
  artifact: {
    identifier: string;
    title: string;
    type: string;
    content: string;
    conversation_uuid?: string;
    conversation_name?: string;
    project?: string;
    tags?: string[];
    embedding?: number[];
  }
): { id: string; version: number; isNew: boolean } {
  // Check for existing versions
  const existing = db.prepare(
    'SELECT id, version FROM artifacts WHERE identifier = ? ORDER BY version DESC LIMIT 1'
  ).get(artifact.identifier) as any;

  const version = existing ? existing.version + 1 : 1;
  const isNew = !existing;

  // Mark all previous versions as not latest
  if (existing) {
    db.prepare('UPDATE artifacts SET is_latest = 0 WHERE identifier = ?').run(artifact.identifier);
  }

  const id = uuid();
  const embBlob = artifact.embedding
    ? Buffer.from(new Float32Array(artifact.embedding).buffer)
    : null;

  db.prepare(`
    INSERT INTO artifacts (id, identifier, title, type, version, is_latest, content, content_length, conversation_uuid, conversation_name, project, embedding, tags, created_at)
    VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
  `).run(
    id,
    artifact.identifier,
    artifact.title,
    artifact.type,
    version,
    artifact.content,
    artifact.content.length,
    artifact.conversation_uuid || null,
    artifact.conversation_name || null,
    artifact.project || null,
    embBlob,
    JSON.stringify(artifact.tags || []),
  );

  return { id, version, isNew };
}

/**
 * Get the latest version of an artifact by title search.
 */
export function getArtifact(db: Database.Database, query: string): Artifact | null {
  // Try exact title match first
  let result = db.prepare(
    'SELECT * FROM artifacts WHERE title LIKE ? AND is_latest = 1 ORDER BY updated_at DESC LIMIT 1'
  ).get(`%${query}%`) as any;

  if (!result) {
    // Try identifier match
    result = db.prepare(
      'SELECT * FROM artifacts WHERE identifier LIKE ? AND is_latest = 1 ORDER BY updated_at DESC LIMIT 1'
    ).get(`%${query}%`) as any;
  }

  return result || null;
}

/**
 * Get all versions of an artifact.
 */
export function getArtifactVersions(db: Database.Database, identifier: string): Artifact[] {
  return db.prepare(
    'SELECT * FROM artifacts WHERE identifier = ? ORDER BY version DESC'
  ).all(identifier) as any[];
}

/**
 * List all latest artifacts.
 */
export function listArtifacts(
  db: Database.Database,
  options: { type?: string; project?: string; limit?: number } = {}
): any[] {
  let sql = 'SELECT * FROM artifacts WHERE is_latest = 1';
  const params: any[] = [];

  if (options.type) { sql += ' AND type = ?'; params.push(options.type); }
  if (options.project) { sql += ' AND project LIKE ?'; params.push(`%${options.project}%`); }

  sql += ' ORDER BY updated_at DESC LIMIT ?';
  params.push(options.limit || 50);

  return db.prepare(sql).all(...params) as any[];
}

/**
 * Search artifacts by content (full-text).
 */
export function searchArtifacts(db: Database.Database, query: string, limit: number = 10): any[] {
  return db.prepare(
    'SELECT id, identifier, title, type, version, project, conversation_name, content_length, created_at FROM artifacts WHERE is_latest = 1 AND (title LIKE ? OR content LIKE ?) ORDER BY updated_at DESC LIMIT ?'
  ).all(`%${query}%`, `%${query}%`, limit) as any[];
}

/**
 * Migrate existing artifact knowledge items into the artifacts table.
 */
export async function migrateArtifactsFromKnowledge(db: Database.Database): Promise<{ migrated: number; skipped: number }> {
  const items = db.prepare(
    "SELECT * FROM knowledge_primary WHERE tags LIKE '%claude-artifact%' ORDER BY source_date ASC"
  ).all() as any[];

  let migrated = 0;
  let skipped = 0;

  for (const item of items) {
    const meta = typeof item.metadata === 'string' ? JSON.parse(item.metadata) : (item.metadata || {});
    const identifier = meta.artifact_identifier;
    if (!identifier) { skipped++; continue; }

    // Check if already migrated
    const existing = db.prepare(
      'SELECT id FROM artifacts WHERE identifier = ? AND conversation_uuid = ?'
    ).get(identifier, meta.conversation_uuid) as any;
    if (existing) { skipped++; continue; }

    const content = meta.content_preview || item.summary || '';
    const title = item.title?.replace(/^Artifact: /, '').replace(/ \(v\d+\)$/, '') || identifier;

    storeArtifact(db, {
      identifier,
      title,
      type: meta.artifact_type || 'code',
      content,
      conversation_uuid: meta.conversation_uuid,
      conversation_name: meta.conversation_name,
      project: item.project,
      tags: typeof item.tags === 'string' ? JSON.parse(item.tags) : (item.tags || []),
    });

    migrated++;
  }

  return { migrated, skipped };
}

/**
 * Pull full artifact content from Claude.ai API for all artifacts
 * that only have preview content (content_length < actual).
 */
export async function enrichArtifactContent(db: Database.Database): Promise<{ enriched: number }> {
  // This would use the Claude.ai API to fetch full artifact content
  // via the wiggle filesystem endpoints:
  // GET /organizations/{org}/conversations/{conv}/wiggle/list-files
  // GET /organizations/{org}/conversations/{conv}/wiggle/download-file?path=X
  //
  // For now, we store what we have from the <antArtifact> tags (which IS the full content)
  return { enriched: 0 };
}
