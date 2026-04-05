import type Database from 'better-sqlite3';
import { v4 as uuid } from 'uuid';
import { request as httpRequest } from 'http';

// ============================================================
// Wiki Agents — Per-project/entity research agents that maintain
// authoritative wiki pages by going to the shelf (actual sources)
//
// Architecture:
//   1. Agent gets focused prompt: "Research everything about [subject]"
//   2. Agent uses MCP tools (prime_search, prime_retrieve, prime_entity)
//   3. Agent reads ACTUAL source material (emails, docs) not summaries
//   4. Agent produces a structured markdown wiki page
//   5. Page stored in compiled_pages table
//   6. Prime COS reads wiki pages instead of raw KB
// ============================================================

// Call the proxy /claude endpoint with MCP tools
async function callAgent(prompt: string, maxTurns: number = 15, timeoutSec: number = 300): Promise<string> {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      prompt,
      timeout: timeoutSec,
      args: ['--max-turns', String(maxTurns)],
    });
    const req = httpRequest('http://localhost:3211/claude', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      timeout: (timeoutSec + 30) * 1000,
    }, (res) => {
      let data = '';
      res.on('data', (d: Buffer) => { data += d.toString(); });
      res.on('end', () => {
        if (res.statusCode === 200) {
          try {
            const parsed = JSON.parse(data);
            resolve(parsed.result || '');
          } catch { resolve(data); }
        } else {
          reject(new Error('Agent proxy returned ' + res.statusCode));
        }
      });
    });
    req.on('error', (err) => reject(err));
    req.on('timeout', () => { req.destroy(); reject(new Error('Agent timeout')); });
    req.write(body);
    req.end();
  });
}

// Compile a wiki page for a PROJECT
export async function compileProjectPage(db: Database.Database, projectName: string): Promise<string> {
  const now = new Date();
  const dayName = ["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"][now.getDay()];
  const dateStr = dayName + ', ' + now.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "America/Denver" });

  // Load corrections for this project
  const corrections = db.prepare(
    "SELECT title, summary FROM knowledge WHERE source IN ('correction', 'manual') AND (summary LIKE ? OR title LIKE ?) ORDER BY source_date DESC LIMIT 10"
  ).all('%' + projectName + '%', '%' + projectName + '%') as any[];

  const correctionText = corrections.length > 0
    ? '\n\nVERIFIED CORRECTIONS (absolute truth — bake these into the page):\n' + corrections.map((c: any) => '- ' + c.title).join('\n')
    : '';

  const prompt = [
    'You are a project research analyst. Your job: produce an authoritative wiki page for the project "' + projectName + '".',
    '',
    'TODAY IS: ' + dateStr + '. Include day-of-week for ALL dates.',
    '',
    'PROCESS:',
    '1. Call prime_search with "' + projectName + '" to find all related knowledge items',
    '2. Call prime_get_commitments to find open commitments for this project',
    '3. For the 3-5 most important recent items, call prime_retrieve to read the ACTUAL source material (emails, documents)',
    '4. If key people are involved, call prime_entity on them',
    '5. Write the wiki page based on what you ACTUALLY READ — not summaries',
    '',
    'OUTPUT FORMAT (return ONLY this markdown):',
    '# ' + projectName,
    '**Status:** [accelerating/steady/stalling/stalled] | **Updated:** ' + dateStr,
    '',
    '## Current Situation',
    '[2-3 sentences: what is happening RIGHT NOW based on the most recent data you retrieved]',
    '',
    '## Key People',
    '[For each person: name, role, last action, what they are doing]',
    '',
    '## Recent Timeline',
    '[Chronological list of recent events with VERIFIED dates including day-of-week]',
    '',
    '## Open Items',
    '[Commitments, action items, decisions needed — with owners]',
    '',
    '## What Zach Should Know',
    '[1-3 bullets]',
    '',
    '## Sources Consulted',
    '[List of source_refs you actually retrieved and read, e.g., "thread:abc123 — Costas email April 1"]',
    '[1-3 bullet points: the things that matter for Zach\'s decisions]',
    '',
    'RULES:',
    '- CITE SOURCES with source_ref IDs: "(thread:abc123, April 2)" so Prime can retrieve the full source if needed',
    '- When you call prime_retrieve, note the thread ID in your citations',
    '- ONLY state facts you verified by reading source material via prime_retrieve',
    '- If you did not read the actual email/document, do NOT claim to know what it says',
    '- Include day-of-week for ALL dates',
    '- Cite sources: "(per [person] email [date])" or "(per calendar)"',
    '- If something is unclear or you could not verify it, say so',
    correctionText,
  ].join('\n');

  const result = await callAgent(prompt, 15, 300);

  // Extract the markdown page from the response
  let page = result;
  // If the response has markdown fences, extract
  const mdMatch = result.match(/```(?:markdown)?\n([\s\S]*?)```/);
  if (mdMatch) page = mdMatch[1];
  // If it starts with #, it's already markdown
  if (!page.startsWith('#')) {
    const hashIdx = page.indexOf('\n#');
    if (hashIdx >= 0) page = page.slice(hashIdx + 1);
  }

  // Store in compiled_pages
  db.prepare(`
    INSERT OR REPLACE INTO compiled_pages (id, page_type, subject_id, subject_name, content, version, source_item_count, last_source_date, compiled_at, stale)
    VALUES (?, 'project', ?, ?, ?, COALESCE((SELECT version + 1 FROM compiled_pages WHERE page_type = 'project' AND subject_id = ?), 1), ?, datetime('now'), datetime('now'), 0)
  `).run(
    uuid(), projectName, projectName, page,
    projectName, 0
  );

  return page;
}

// Compile a wiki page for an ENTITY (person)
export async function compileEntityPage(db: Database.Database, entityName: string, entityId: string): Promise<string> {
  const now = new Date();
  const dayName = ["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"][now.getDay()];
  const dateStr = dayName + ', ' + now.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "America/Denver" });

  const corrections = db.prepare(
    "SELECT title, summary FROM knowledge WHERE source IN ('correction', 'manual') AND (summary LIKE ? OR title LIKE ?) ORDER BY source_date DESC LIMIT 10"
  ).all('%' + entityName + '%', '%' + entityName + '%') as any[];

  const correctionText = corrections.length > 0
    ? '\n\nVERIFIED CORRECTIONS (absolute truth):\n' + corrections.map((c: any) => '- ' + c.title).join('\n')
    : '';

  const prompt = [
    'You are an entity research analyst. Produce an authoritative wiki page for "' + entityName + '".',
    '',
    'TODAY IS: ' + dateStr + '.',
    '',
    'PROCESS:',
    '1. Call prime_entity with "' + entityName + '" to get their profile',
    '2. Call prime_search with "' + entityName + '" to find all related items',
    '3. For the 3 most recent items involving this person, call prime_retrieve to read ACTUAL source',
    '4. Write the wiki page based on what you ACTUALLY READ',
    '',
    'OUTPUT FORMAT (return ONLY this markdown):',
    '# ' + entityName,
    '**Role:** [their role/title] | **Relationship:** [how they relate to Zach] | **Updated:** ' + dateStr,
    '',
    '## Current State',
    '[What is this person doing right now? What is their stance/position?]',
    '',
    '## Key Facts (verified)',
    '[Bullet list of facts verified from actual source material. Tag corrections with [CORRECTION]]',
    '',
    '## Recent Communication',
    '[Last 3-5 interactions with dates, day-of-week, and what was discussed]',
    '',
    '## Open Items',
    '[What this person owes Zach, what Zach owes them, pending decisions]',
    '',
    'RULES: CITE SOURCES with source_ref IDs. Same as project page — only verified facts, cite sources, day-of-week on dates.',
    correctionText,
  ].join('\n');

  const result = await callAgent(prompt, 12, 240);

  let page = result;
  const mdMatch = result.match(/```(?:markdown)?\n([\s\S]*?)```/);
  if (mdMatch) page = mdMatch[1];
  if (!page.startsWith('#')) {
    const hashIdx = page.indexOf('\n#');
    if (hashIdx >= 0) page = page.slice(hashIdx + 1);
  }

  db.prepare(`
    INSERT OR REPLACE INTO compiled_pages (id, page_type, subject_id, subject_name, content, version, last_source_date, compiled_at, stale)
    VALUES (?, 'entity', ?, ?, ?, COALESCE((SELECT version + 1 FROM compiled_pages WHERE page_type = 'entity' AND subject_id = ?), 1), datetime('now'), datetime('now'), 0)
  `).run(uuid(), entityId, entityName, page, entityId);

  return page;
}

// Compile pages for all active projects and key entities
export async function compileAllPages(db: Database.Database): Promise<{ projects: number; entities: number; errors: string[] }> {
  const errors: string[] = [];
  let projectCount = 0;
  let entityCount = 0;

  // Active projects (top 8 by recent activity)
  const projects = db.prepare(`
    SELECT project, COUNT(*) as cnt, MAX(source_date) as last_activity
    FROM knowledge WHERE project IS NOT NULL AND project != ''
    AND source_date >= datetime('now', '-30 days')
    GROUP BY project HAVING cnt >= 3
    ORDER BY last_activity DESC LIMIT 8
  `).all() as any[];

  console.log('    Compiling ' + projects.length + ' project wiki pages (parallel)...');
  const projectResults = await Promise.allSettled(
    projects.map(p => compileProjectPage(db, p.project).then(() => {
      projectCount++;
      console.log('      ' + p.project + ' compiled');
      return p.project;
    }))
  );
  for (const r of projectResults) {
    if (r.status === 'rejected') {
      errors.push('project: ' + (r.reason?.message || '').slice(0, 80));
    }
  }

  // Key entities (top 10 active, non-dismissed)
  const entities = db.prepare(`
    SELECT e.id, e.canonical_name, COUNT(DISTINCT k.id) as mentions
    FROM entities e
    JOIN entity_mentions em ON e.id = em.entity_id
    JOIN knowledge k ON em.knowledge_item_id = k.id
    WHERE e.user_dismissed = 0 AND e.type = 'person'
    AND e.canonical_name NOT LIKE '%Zach%Stock%'
    AND k.source_date >= datetime('now', '-30 days')
    AND (e.user_label IS NOT NULL OR (SELECT COUNT(*) FROM entity_mentions em2 WHERE em2.entity_id = e.id) >= 5)
    GROUP BY e.id
    ORDER BY mentions DESC LIMIT 10
  `).all() as any[];

  console.log('    Compiling ' + entities.length + ' entity wiki pages (parallel)...');
  const entityResults = await Promise.allSettled(
    entities.map(e => compileEntityPage(db, e.canonical_name, e.id).then(() => {
      entityCount++;
      console.log('      ' + e.canonical_name + ' compiled');
      return e.canonical_name;
    }))
  );
  for (const r of entityResults) {
    if (r.status === 'rejected') {
      errors.push('entity: ' + (r.reason?.message || '').slice(0, 80));
    }
  }

  return { projects: projectCount, entities: entityCount, errors };
}

// Get all compiled wiki pages as context for the COS
export function getWikiContext(db: Database.Database): string {
  const pages = db.prepare(
    "SELECT page_type, subject_name, content, compiled_at FROM compiled_pages ORDER BY page_type, compiled_at DESC"
  ).all() as any[];

  if (pages.length === 0) return '(No wiki pages compiled yet)';

  const sections: string[] = [];
  sections.push('# COMPILED WIKI PAGES (authoritative, source-verified)\n');

  for (const page of pages) {
    sections.push(page.content);
    sections.push('\n---\n');
  }

  return sections.join('\n');
}
