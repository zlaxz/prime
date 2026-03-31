/**
 * Index Cowork Output Files — finished work products into Prime knowledge base
 *
 * Scans Cowork session output directories for .md, .txt, .csv, .docx, .pdf files.
 * Deduplicates versioned files (keeps only the latest v1/v2/v3 etc).
 * Stores full content in raw_content for source retrieval.
 * Skips embeddings — batch-embeddings.ts handles those separately.
 *
 * Usage: cd ~/GitHub/prime && npx tsx scripts/index-cowork-outputs.ts
 */

import { readdirSync, readFileSync, statSync, existsSync } from 'fs';
import { join, extname, basename, resolve } from 'path';
import { homedir } from 'os';
import { execSync } from 'child_process';
import { createHash } from 'crypto';
import { v4 as uuid } from 'uuid';
import { getDb, insertKnowledge, type KnowledgeItem } from '../src/db.js';

// ── Config ──

const SOURCE_DIRS = [
  join(homedir(), 'laptop-sources', 'cowork'),
  join(homedir(), 'Library', 'Application Support', 'Claude', 'local-agent-mode-sessions'),
];

const INDEXABLE_EXTENSIONS = new Set(['.md', '.txt', '.csv', '.docx', '.pdf']);
const SKIP_FILES = new Set(['.DS_Store', 'Thumbs.db']);

// Known project names to match against paths/filenames
const PROJECT_PATTERNS: [RegExp, string][] = [
  [/carefront/i, 'CareFront'],
  [/foresite/i, 'ForeSite'],
  [/recapture/i, 'Recapture'],
  [/prime/i, 'Prime'],
  [/gridprotect/i, 'GridProtect'],
  [/bishop\s*street/i, 'Bishop Street'],
];

// Version pattern: _v1, _v2, -v3, v4. etc (at end of filename stem)
const VERSION_REGEX = /[-_]?v(\d+)$/i;

// ── Helpers ──

function hashPath(filepath: string): string {
  return createHash('sha256').update(filepath).digest('hex').slice(0, 16);
}

function makeSourceRef(filepath: string): string {
  return `cowork-output:${hashPath(filepath)}`;
}

function stripVersionSuffix(name: string): string {
  return name.replace(VERSION_REGEX, '');
}

function extractVersion(name: string): number {
  const match = name.match(VERSION_REGEX);
  return match ? parseInt(match[1], 10) : 0;
}

function detectProject(filepath: string, filename: string): string | null {
  const combined = `${filepath} ${filename}`;
  for (const [pattern, name] of PROJECT_PATTERNS) {
    if (pattern.test(combined)) return name;
  }
  return null;
}

function readFileContent(filepath: string): string | null {
  const ext = extname(filepath).toLowerCase();

  try {
    if (ext === '.md' || ext === '.txt' || ext === '.csv') {
      return readFileSync(filepath, 'utf-8');
    }

    if (ext === '.docx') {
      // macOS built-in textutil
      return execSync(`textutil -convert txt -stdout "${filepath}"`, {
        encoding: 'utf-8',
        timeout: 15000,
      });
    }

    if (ext === '.pdf') {
      try {
        return execSync(`pdftotext "${filepath}" -`, {
          encoding: 'utf-8',
          timeout: 15000,
        });
      } catch {
        console.log(`    [skip] pdftotext not available for ${basename(filepath)}`);
        return null;
      }
    }
  } catch (err: any) {
    console.log(`    [skip] Failed to read ${basename(filepath)}: ${err.message?.slice(0, 80)}`);
    return null;
  }

  return null;
}

/** Recursively find all files in outputs/ directories within Cowork sessions */
function findOutputFiles(baseDir: string): string[] {
  const results: string[] = [];

  function walk(dir: string, insideOutputs: boolean) {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (entry.name.startsWith('.') && entry.name !== '.') continue;
      if (SKIP_FILES.has(entry.name)) continue;
      if (entry.name.endsWith('.tmp') || entry.name.endsWith('.lock')) continue;

      const fullPath = join(dir, entry.name);

      if (entry.isDirectory()) {
        // Enter outputs/ directories, or keep walking to find them
        const isOutputsDir = entry.name.toLowerCase() === 'outputs';
        walk(fullPath, insideOutputs || isOutputsDir);
      } else if (entry.isFile() && insideOutputs) {
        const ext = extname(entry.name).toLowerCase();
        if (INDEXABLE_EXTENSIONS.has(ext) && !entry.name.endsWith('.pptx')) {
          results.push(fullPath);
        }
      }
    }
  }

  walk(baseDir, false);
  return results;
}

/** Group files by base name (version stripped), keep only the latest version */
function deduplicateVersions(files: string[]): string[] {
  const groups = new Map<string, { path: string; mtime: number; version: number }[]>();

  for (const filepath of files) {
    const name = basename(filepath, extname(filepath));
    const baseKey = stripVersionSuffix(name);
    // Include parent directory in key to avoid cross-session collisions
    const dirKey = resolve(filepath, '..') + '/' + baseKey;

    if (!groups.has(dirKey)) groups.set(dirKey, []);
    groups.get(dirKey)!.push({
      path: filepath,
      mtime: statSync(filepath).mtimeMs,
      version: extractVersion(name),
    });
  }

  const result: string[] = [];
  for (const [, variants] of groups) {
    // Sort by version descending, then mtime descending — take the first
    variants.sort((a, b) => b.version - a.version || b.mtime - a.mtime);
    result.push(variants[0].path);
  }

  return result;
}

// ── Main ──

async function main() {
  console.log('\n--- INDEX COWORK OUTPUTS ---\n');

  const db = getDb();

  // Load existing source_refs to skip already-indexed files
  const existingRefs = new Set<string>();
  const rows = db.prepare("SELECT source_ref FROM knowledge WHERE source = 'cowork-output'").all() as any[];
  for (const r of rows) existingRefs.add(r.source_ref);
  console.log(`Already indexed: ${existingRefs.size} cowork output items\n`);

  // Collect all output files from all source directories
  let allFiles: string[] = [];
  for (const dir of SOURCE_DIRS) {
    if (!existsSync(dir)) {
      console.log(`  [skip] ${dir} — does not exist`);
      continue;
    }
    const found = findOutputFiles(dir);
    console.log(`  ${dir} — ${found.length} output files found`);
    allFiles.push(...found);
  }

  if (allFiles.length === 0) {
    console.log('\nNo output files found. Nothing to index.');
    return;
  }

  // Deduplicate versioned files
  const dedupedFiles = deduplicateVersions(allFiles);
  const versionSkipped = allFiles.length - dedupedFiles.length;
  if (versionSkipped > 0) {
    console.log(`\nVersion dedup: ${versionSkipped} older versions skipped, ${dedupedFiles.length} latest kept`);
  }

  // Filter out already-indexed
  const newFiles = dedupedFiles.filter(f => !existingRefs.has(makeSourceRef(f)));
  console.log(`\nNew files to index: ${newFiles.length} (${dedupedFiles.length - newFiles.length} already indexed)\n`);

  if (newFiles.length === 0) {
    console.log('Nothing new to index.');
    return;
  }

  // Index each file
  let indexed = 0;
  let skipped = 0;

  for (const filepath of newFiles) {
    const filename = basename(filepath);
    const nameNoExt = basename(filepath, extname(filepath));

    const content = readFileContent(filepath);
    if (!content || content.trim().length < 10) {
      console.log(`  [skip] ${filename} — empty or unreadable`);
      skipped++;
      continue;
    }

    const fileStat = statSync(filepath);
    const project = detectProject(filepath, filename);
    const summary = content.trim().slice(0, 500);

    const item: KnowledgeItem = {
      id: uuid(),
      title: nameNoExt,
      summary,
      source: 'cowork-output',
      source_ref: makeSourceRef(filepath),
      source_date: fileStat.mtime.toISOString(),
      contacts: [],
      organizations: [],
      decisions: [],
      commitments: [],
      action_items: [],
      tags: ['cowork', 'work-product', extname(filepath).slice(1)],
      project,
      importance: 'high',
      embedding: undefined, // batch-embeddings.ts handles this
      metadata: {
        original_path: filepath,
        file_size: fileStat.size,
        extension: extname(filepath),
      },
    };

    insertKnowledge(db, item);

    // Store full content in raw_content column (insertKnowledge doesn't handle this field)
    db.prepare('UPDATE knowledge SET raw_content = ?, extraction_version = 1 WHERE id = ?')
      .run(content, item.id);

    indexed++;
    console.log(`  [+] ${filename}${project ? ` (${project})` : ''} — ${(fileStat.size / 1024).toFixed(1)}KB`);
  }

  // Update sync state
  db.prepare(
    `INSERT OR REPLACE INTO sync_state (source, last_sync_at, items_synced, status, updated_at)
     VALUES ('cowork-output', datetime('now'), ?, 'idle', datetime('now'))`
  ).run(indexed);

  console.log(`\nDone: ${indexed} indexed, ${skipped} skipped\n`);
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
