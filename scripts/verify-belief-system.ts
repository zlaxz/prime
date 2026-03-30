#!/usr/bin/env npx tsx
/**
 * Belief System Verification Suite
 * Tests every layer of the provenance architecture.
 * Run after dream pipeline: node --import tsx scripts/verify-belief-system.ts
 */

import { getDb } from '../src/db.js';
import { existsSync, statSync, readFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const db = getDb();
let passed = 0;
let failed = 0;

function test(name: string, fn: () => boolean) {
  try {
    const result = fn();
    if (result) {
      console.log(`  ✓ ${name}`);
      passed++;
    } else {
      console.log(`  ✗ ${name}`);
      failed++;
    }
  } catch (err: any) {
    console.log(`  ✗ ${name} — ERROR: ${err.message.slice(0, 100)}`);
    failed++;
  }
}

console.log('\n=== BELIEF SYSTEM VERIFICATION ===\n');

// ── 1. SQL Views Exist ──────────────────────────────────────
console.log('1. SQL Views');

test('knowledge_primary view exists', () => {
  const r = db.prepare('SELECT COUNT(*) as cnt FROM knowledge_primary').get() as any;
  return r.cnt > 0;
});

test('knowledge_derived view exists', () => {
  const r = db.prepare('SELECT COUNT(*) as cnt FROM knowledge_derived').get() as any;
  return r.cnt >= 0; // might be 0 if no agent reports
});

test('primary + derived = total', () => {
  const p = (db.prepare('SELECT COUNT(*) as cnt FROM knowledge_primary').get() as any).cnt;
  const d = (db.prepare('SELECT COUNT(*) as cnt FROM knowledge_derived').get() as any).cnt;
  const t = (db.prepare('SELECT COUNT(*) as cnt FROM knowledge').get() as any).cnt;
  return p + d === t;
});

test('derived sources excluded from primary', () => {
  const r = db.prepare(
    "SELECT COUNT(*) as cnt FROM knowledge_primary WHERE source IN ('agent-report', 'agent-notification', 'briefing', 'directive')"
  ).get() as any;
  return r.cnt === 0;
});

// ── 2. Entity Graph Quarantine ──────────────────────────────
console.log('\n2. Entity Graph Quarantine');

test('zero entity mentions from derived sources', () => {
  const r = db.prepare(`
    SELECT COUNT(*) as cnt FROM entity_mentions em
    JOIN knowledge_derived kd ON em.knowledge_item_id = kd.id
  `).get() as any;
  return r.cnt === 0;
});

test('zero edge evidence from derived sources', () => {
  const r = db.prepare(`
    SELECT COUNT(*) as cnt FROM edge_evidence ev
    JOIN knowledge_derived kd ON ev.knowledge_item_id = kd.id
  `).get() as any;
  return r.cnt === 0;
});

test('no phantom edges (zero evidence)', () => {
  const r = db.prepare(`
    SELECT COUNT(*) as cnt FROM entity_edges
    WHERE invalid_at IS NULL
      AND id NOT IN (SELECT DISTINCT edge_id FROM edge_evidence)
  `).get() as any;
  return r.cnt === 0;
});

// ── 3. Charlie Bernier Test (the canary) ────────────────────
console.log('\n3. Charlie Bernier Test');

const charlie = db.prepare("SELECT id FROM entities WHERE canonical_name = 'Charlie Bernier'").get() as any;

test('Charlie Bernier NOT in Carefront (entity graph)', () => {
  if (!charlie) return false;
  const projects = db.prepare(`
    SELECT DISTINCT k.project FROM knowledge_primary k
    JOIN entity_mentions em ON k.id = em.knowledge_item_id
    WHERE em.entity_id = ? AND k.project IS NOT NULL AND k.project LIKE '%Carefront%'
  `).all(charlie.id) as any[];
  return projects.length === 0;
});

test('Charlie Bernier NOT in Carefront (commitments)', () => {
  const r = db.prepare(`
    SELECT COUNT(*) as cnt FROM commitments
    WHERE (owner LIKE '%Charlie%' OR assigned_to LIKE '%Charlie%' OR text LIKE '%Charlie%')
      AND project LIKE '%Carefront%'
      AND state IN ('active', 'overdue', 'detected')
  `).get() as any;
  return r.cnt === 0;
});

test('Charlie Bernier IS in Physician Cyber (entity graph)', () => {
  if (!charlie) return false;
  const projects = db.prepare(`
    SELECT DISTINCT k.project FROM knowledge_primary k
    JOIN entity_mentions em ON k.id = em.knowledge_item_id
    WHERE em.entity_id = ? AND k.project LIKE '%Physician Cyber%'
  `).all(charlie.id) as any[];
  return projects.length > 0;
});

// ── 4. Commitment-Source Consistency ─────────────────────────
console.log('\n4. Commitment-Source Consistency');

test('no active commitment-source project mismatches', () => {
  const mismatches = db.prepare(`
    SELECT COUNT(*) as cnt FROM commitments c
    JOIN knowledge k ON c.detected_from = k.id
    WHERE c.project IS NOT NULL AND k.project IS NOT NULL
      AND c.state IN ('active', 'overdue', 'detected')
      AND LOWER(REPLACE(c.project, ' ', '')) != LOWER(REPLACE(k.project, ' ', ''))
  `).get() as any;
  return mismatches.cnt === 0;
});

// ── 5. Entity Profiles (from dream pipeline) ────────────────
console.log('\n5. Entity Profiles');

test('entity profiles exist', () => {
  const r = db.prepare('SELECT COUNT(*) as cnt FROM entity_profiles').get() as any;
  return r.cnt > 0;
});

test('profiles have surface and suppress verdicts', () => {
  const surface = (db.prepare("SELECT COUNT(*) as cnt FROM entity_profiles WHERE alert_verdict = 'surface'").get() as any).cnt;
  const suppress = (db.prepare("SELECT COUNT(*) as cnt FROM entity_profiles WHERE alert_verdict = 'suppress'").get() as any).cnt;
  return surface > 0 && suppress > 0;
});

// ── 6. Verified Entity-Project Map ──────────────────────────
console.log('\n6. Verified Entity-Project Map');

test('verified_entity_projects exists in graph_state', () => {
  const r = db.prepare("SELECT value FROM graph_state WHERE key = 'verified_entity_projects'").get() as any;
  if (!r) return false;
  const data = JSON.parse(r.value);
  return Array.isArray(data) && data.length > 0;
});

test('Charlie Bernier → Physician Cyber in verified map', () => {
  const r = db.prepare("SELECT value FROM graph_state WHERE key = 'verified_entity_projects'").get() as any;
  if (!r) return false;
  const data = JSON.parse(r.value);
  return data.some((ep: any) =>
    ep.canonical_name === 'Charlie Bernier' && ep.project.includes('Physician Cyber')
  );
});

test('Charlie Bernier NOT → Carefront in verified map', () => {
  const r = db.prepare("SELECT value FROM graph_state WHERE key = 'verified_entity_projects'").get() as any;
  if (!r) return false;
  const data = JSON.parse(r.value);
  return !data.some((ep: any) =>
    ep.canonical_name === 'Charlie Bernier' && ep.project.includes('Carefront')
  );
});

// ── 7. World Narrative Quality ──────────────────────────────
console.log('\n7. World Narrative');

test('world-narrative.md exists and is recent', () => {
  const narrativePath = join(homedir(), '.prime', 'world-narrative.md');
  if (!existsSync(narrativePath)) return false;
  const stat = statSync(narrativePath);
  const ageHours = (Date.now() - stat.mtimeMs) / 3600000;
  return ageHours < 24;
});

test('world narrative does NOT mention Charlie + Carefront together', () => {
  const narrativePath = join(homedir(), '.prime', 'world-narrative.md');
  if (!existsSync(narrativePath)) return false;
  const content = readFileSync(narrativePath, 'utf-8');
  // Check for Charlie in a Carefront context (within 200 chars)
  const charlieIdx = content.indexOf('Charlie');
  if (charlieIdx === -1) return true; // Charlie not mentioned at all = pass
  const context = content.slice(Math.max(0, charlieIdx - 200), charlieIdx + 200);
  return !context.includes('Carefront');
});

// ── 8. Dream Pipeline Health ────────────────────────────────
console.log('\n8. Dream Pipeline');

test('accuracy score exists and > 50%', () => {
  const r = db.prepare("SELECT value FROM graph_state WHERE key = 'accuracy_history'").get() as any;
  if (!r) return false;
  const scores = JSON.parse(r.value);
  if (scores.length === 0) return false;
  const latest = scores[scores.length - 1];
  return latest.accuracy > 0.5;
});

test('project profiles exist', () => {
  const r = db.prepare("SELECT value FROM graph_state WHERE key = 'project_profiles'").get() as any;
  if (!r) return false;
  const data = JSON.parse(r.value);
  return Array.isArray(data) && data.length > 0;
});

// ── Summary ─────────────────────────────────────────────────
console.log(`\n${'='.repeat(40)}`);
console.log(`RESULTS: ${passed} passed, ${failed} failed, ${passed + failed} total`);
console.log(`${failed === 0 ? '✓ ALL TESTS PASSED' : '✗ SOME TESTS FAILED'}`);
console.log(`${'='.repeat(40)}\n`);

process.exit(failed > 0 ? 1 : 0);
