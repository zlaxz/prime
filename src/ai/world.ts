import type Database from 'better-sqlite3';
import { existsSync, writeFileSync, mkdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { getAlerts } from './intelligence.js';

// ============================================================
// World Model Generator — Phase 4 of v1.0 Brain Architecture
// Pure SQL queries, zero LLM calls, <300ms
// Every claim cites entity/item IDs
// ============================================================

const WORLD_PATH = join(homedir(), '.prime', 'world.md');
const WORLD_JSON_PATH = join(homedir(), '.prime', 'world.json');
const WORLD_HISTORY_DIR = join(homedir(), '.prime', 'world.history');

interface WorldPerson {
  id: string;
  name: string;
  email: string | null;
  relationship_type: string | null;
  user_label: string | null;
  mention_count: number;
  inbound: number;
  outbound: number;
  last_seen: string | null;
  days_since: number;
  status: string;
  projects: string[];
  commitments: any[];
  citations: string[];
}

interface WorldProject {
  name: string;
  item_count: number;
  last_activity: string | null;
  days_since: number;
  sources: string[];
  people: { name: string; count: number }[];
  commitments: any[];
  stale: boolean;
}

interface WorldAlert {
  type: string;
  severity: string;
  title: string;
  detail: string;
  entity_id: string | null;
  item_id: string | null;
  days: number;
  confidence: number;
  reasoning: string;
}

interface WorldModel {
  generated_at: string;
  stale_after: string;
  stats: { entities: number; items: number; facts: number; alerts: number };
  people: WorldPerson[];
  projects: WorldProject[];
  alerts: WorldAlert[];
  dismissed: { id: string; name: string; reason: string | null }[];
  cross_connections: { name: string; projects: string[]; count: number }[];
}

function computeStatus(days: number | null): string {
  if (days === null) return 'unknown';
  if (days <= 3) return 'active';
  if (days <= 7) return 'warm';
  if (days <= 14) return 'cooling';
  if (days <= 30) return 'cold';
  return 'dormant';
}

function daysSince(dateStr: string | null): number {
  if (!dateStr) return 999;
  return Math.floor((Date.now() - new Date(dateStr).getTime()) / 86400000);
}

export function generateWorldModel(db: Database.Database): WorldModel {
  const now = new Date();
  const nowISO = now.toISOString();

  // ── PEOPLE ──────────────────────────────────────────────
  const peopleRaw = db.prepare(`
    SELECT e.id, e.canonical_name, e.email, e.relationship_type, e.user_label, e.user_dismissed,
      COUNT(em.id) as mention_count,
      SUM(CASE WHEN em.direction = 'inbound' THEN 1 ELSE 0 END) as inbound,
      SUM(CASE WHEN em.direction = 'outbound' THEN 1 ELSE 0 END) as outbound,
      MAX(em.mention_date) as last_seen
    FROM entities e
    LEFT JOIN entity_mentions em ON e.id = em.entity_id
    WHERE e.type = 'person' AND e.user_dismissed = 0 AND e.canonical_name != 'Zach Stock'
    GROUP BY e.id
    HAVING mention_count >= 2
    ORDER BY mention_count DESC
    LIMIT 20
  `).all() as any[];

  const people: WorldPerson[] = peopleRaw.map(p => {
    const days = daysSince(p.last_seen);

    // Get projects
    const projects = db.prepare(`
      SELECT DISTINCT k.project FROM knowledge_primary k
      JOIN entity_mentions em ON k.id = em.knowledge_item_id
      WHERE em.entity_id = ? AND k.project IS NOT NULL
    `).all(p.id) as any[];

    // Get commitments
    const commitments = db.prepare(`
      SELECT id, text, state, due_date FROM commitments
      WHERE (owner LIKE ? OR assigned_to LIKE ?) AND state IN ('active', 'overdue')
    `).all(`%${p.canonical_name}%`, `%${p.canonical_name}%`) as any[];

    // Get recent item IDs for citation
    const citations = db.prepare(`
      SELECT k.id FROM knowledge_primary k
      JOIN entity_mentions em ON k.id = em.knowledge_item_id
      WHERE em.entity_id = ? ORDER BY k.source_date DESC LIMIT 3
    `).all(p.id) as any[];

    return {
      id: p.id,
      name: p.canonical_name,
      email: p.email,
      relationship_type: p.user_label || p.relationship_type,
      user_label: p.user_label,
      mention_count: p.mention_count,
      inbound: p.inbound || 0,
      outbound: p.outbound || 0,
      last_seen: p.last_seen,
      days_since: days,
      status: computeStatus(days),
      projects: projects.map((pr: any) => pr.project),
      commitments,
      citations: citations.map((c: any) => c.id),
    };
  });

  // ── PROJECTS ──────────────────────────────────────────────
  const projectsRaw = db.prepare(`
    SELECT project, COUNT(*) as item_count,
      MAX(source_date) as last_activity,
      GROUP_CONCAT(DISTINCT source) as sources
    FROM knowledge_primary
    WHERE project IS NOT NULL AND project != ''
    GROUP BY project
    HAVING item_count >= 2
    ORDER BY MAX(source_date) DESC
    LIMIT 15
  `).all() as any[];

  const projects: WorldProject[] = projectsRaw.map(p => {
    const days = daysSince(p.last_activity);

    // Get people involved
    const projectPeople = db.prepare(`
      SELECT e.canonical_name, COUNT(*) as cnt
      FROM entity_mentions em
      JOIN knowledge_primary k ON em.knowledge_item_id = k.id
      JOIN entities e ON em.entity_id = e.id
      WHERE k.project = ? AND e.type = 'person' AND e.user_dismissed = 0 AND e.canonical_name != 'Zach Stock'
      GROUP BY e.id ORDER BY cnt DESC LIMIT 5
    `).all(p.project) as any[];

    // Get commitments
    const commitments = db.prepare(`
      SELECT id, text, state, due_date FROM commitments
      WHERE project = ? AND state IN ('active', 'overdue')
    `).all(p.project) as any[];

    return {
      name: p.project,
      item_count: p.item_count,
      last_activity: p.last_activity,
      days_since: days,
      sources: (p.sources || '').split(','),
      people: projectPeople.map((pp: any) => ({ name: pp.canonical_name, count: pp.cnt })),
      commitments,
      stale: days > 14,
    };
  });

  // ── ALERTS (single source of truth: getAlerts) ──────────
  // Uses person-level reasoning, not item-level scanning
  const rawAlerts = getAlerts(db);
  const alerts: WorldAlert[] = rawAlerts.map(a => ({
    type: a.type,
    severity: a.severity,
    title: a.title,
    detail: a.detail,
    entity_id: null,
    item_id: a.item_id || null,
    days: a.daysSince || 0,
    confidence: a.confidence || 0.5,
    reasoning: a.reasoning || '',
  }));

  // ── DISMISSED ──────────────────────────────────────────────
  const dismissed = db.prepare(`
    SELECT id, canonical_name, user_notes FROM entities WHERE user_dismissed = 1
  `).all() as any[];

  // Also get domain dismissals
  const domainDismissals = db.prepare(`
    SELECT DISTINCT domain, reason FROM dismissals WHERE domain IS NOT NULL
  `).all() as any[];

  const dismissedList = [
    ...dismissed.map((d: any) => ({ id: d.id, name: d.canonical_name, reason: d.user_notes })),
    ...domainDismissals.map((d: any) => ({ id: '', name: `domain:${d.domain}`, reason: d.reason })),
  ];

  // ── CROSS-PROJECT CONNECTIONS ──────────────────────────────
  const crossProject = db.prepare(`
    SELECT e.canonical_name, GROUP_CONCAT(DISTINCT k.project) as projects, COUNT(DISTINCT k.project) as proj_count, COUNT(*) as total
    FROM entity_mentions em
    JOIN entities e ON em.entity_id = e.id
    JOIN knowledge_primary k ON em.knowledge_item_id = k.id
    WHERE e.type = 'person' AND e.user_dismissed = 0 AND k.project IS NOT NULL
      AND e.canonical_name != 'Zach Stock'
    GROUP BY e.id
    HAVING proj_count >= 2
    ORDER BY proj_count DESC, total DESC
    LIMIT 10
  `).all() as any[];

  // ── STATS ──────────────────────────────────────────────
  const totalItems = (db.prepare('SELECT COUNT(*) as cnt FROM knowledge_primary').get() as any).cnt;
  const totalEntities = (db.prepare('SELECT COUNT(*) as cnt FROM entities WHERE user_dismissed = 0').get() as any).cnt;
  const totalFacts = (db.prepare('SELECT COUNT(*) as cnt FROM facts WHERE valid_until IS NULL').get() as any).cnt;

  const model: WorldModel = {
    generated_at: nowISO,
    stale_after: new Date(now.getTime() + 12 * 3600000).toISOString(),
    stats: { entities: totalEntities, items: totalItems, facts: totalFacts, alerts: alerts.length },
    people,
    projects,
    alerts,
    dismissed: dismissedList,
    cross_connections: crossProject.map((c: any) => ({
      name: c.canonical_name,
      projects: (c.projects || '').split(','),
      count: c.total,
    })),
  };

  return model;
}

// ── Format as Markdown ──────────────────────────────────────

export function worldModelToMarkdown(model: WorldModel): string {
  const lines: string[] = [];
  lines.push(`# World Model — ${new Date(model.generated_at).toLocaleString()}`);
  lines.push(`Items: ${model.stats.items} | Entities: ${model.stats.entities} | Facts: ${model.stats.facts} | Alerts: ${model.stats.alerts}\n`);

  // People
  lines.push('## People\n');
  for (const p of model.people) {
    const label = p.user_label ? `${p.user_label}` : (p.relationship_type || '?');
    const cite = p.citations.length ? ` [${p.citations.map(c => c.slice(0, 8)).join(',')}]` : '';
    lines.push(`### ${p.name} [${label} | ${p.status} | ${p.days_since}d | ${p.mention_count} mentions]${cite}`);
    if (p.email) lines.push(`  Email: ${p.email}`);
    lines.push(`  Communication: ${p.inbound} in / ${p.outbound} out`);
    if (p.projects.length) lines.push(`  Projects: ${p.projects.slice(0, 5).join(', ')}`);
    if (p.commitments.length) {
      for (const c of p.commitments) {
        lines.push(`  📋 ${c.text} [${c.state}]${c.due_date ? ` due: ${c.due_date}` : ''}`);
      }
    }
    lines.push('');
  }

  // Projects
  lines.push('## Projects\n');
  for (const p of model.projects) {
    const staleTag = p.stale ? ' ⚠ STALE' : '';
    lines.push(`### ${p.name} [${p.item_count} items | ${p.days_since}d ago${staleTag}]`);
    if (p.people.length) lines.push(`  People: ${p.people.map(pp => `${pp.name}(${pp.count})`).join(', ')}`);
    if (p.commitments.length) {
      for (const c of p.commitments) {
        lines.push(`  📋 ${c.text} [${c.state}]`);
      }
    }
    lines.push('');
  }

  // Alerts
  if (model.alerts.length > 0) {
    lines.push('## Needs Attention\n');
    const icons: Record<string, string> = { critical: '🔴', high: '🟠', normal: '🔵' };
    for (const a of model.alerts) {
      const cite = a.item_id ? ` [${a.item_id.slice(0, 8)}]` : '';
      const conf = a.confidence ? ` (${Math.round(a.confidence * 100)}% confidence)` : '';
      lines.push(`${icons[a.severity] || '⚪'} ${a.title} — ${a.detail}${conf}${cite}`);
      if (a.reasoning) lines.push(`  Why: ${a.reasoning}`);
    }
    lines.push('');
  }

  // Dismissed
  if (model.dismissed.length > 0) {
    lines.push('## Dismissed (agents: skip these)\n');
    for (const d of model.dismissed) {
      lines.push(`- ${d.name}${d.reason ? ` (${d.reason})` : ''}`);
    }
    lines.push('');
  }

  // Cross-project
  if (model.cross_connections.length > 0) {
    lines.push('## Cross-Project Connections\n');
    for (const c of model.cross_connections) {
      lines.push(`- ${c.name}: ${c.projects.join(', ')} (${c.count} items)`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

// ── Save to disk ────────────────────────────────────────────

export function saveWorldModel(model: WorldModel): void {
  // Ensure dirs
  if (!existsSync(WORLD_HISTORY_DIR)) mkdirSync(WORLD_HISTORY_DIR, { recursive: true });

  // Archive previous version
  if (existsSync(WORLD_PATH)) {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const archivePath = join(WORLD_HISTORY_DIR, `world-${timestamp}.md`);
    writeFileSync(archivePath, readFileSync(WORLD_PATH, 'utf-8'));
  }

  // Write new
  const md = worldModelToMarkdown(model);
  writeFileSync(WORLD_PATH, md);
  writeFileSync(WORLD_JSON_PATH, JSON.stringify(model, null, 2));
}

// ── Staleness check ─────────────────────────────────────────

export function isWorldModelStale(db: Database.Database): boolean {
  if (!existsSync(WORLD_JSON_PATH)) return true;

  try {
    const world = JSON.parse(readFileSync(WORLD_JSON_PATH, 'utf-8'));
    if (new Date() > new Date(world.stale_after)) return true;

    const newItems = (db.prepare(
      'SELECT COUNT(*) as cnt FROM knowledge_primary WHERE created_at > ?'
    ).get(world.generated_at) as any).cnt;
    if (newItems >= 10) return true;

    return false;
  } catch {
    return true;
  }
}

// ── Get for prompt injection ────────────────────────────────

export function getWorldModelForPrompt(db: Database.Database): string {
  if (isWorldModelStale(db)) {
    const model = generateWorldModel(db);
    saveWorldModel(model);
    return worldModelToMarkdown(model);
  }

  if (existsSync(WORLD_PATH)) {
    return readFileSync(WORLD_PATH, 'utf-8');
  }

  // Generate fresh
  const model = generateWorldModel(db);
  saveWorldModel(model);
  return worldModelToMarkdown(model);
}
