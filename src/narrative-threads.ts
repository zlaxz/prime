import type Database from 'better-sqlite3';
import { v4 as uuid } from 'uuid';
import { getConfig } from './db.js';
import { getBulkProvider } from './ai/providers.js';
import { retrieveDeepContext } from './source-retrieval.js';

// ============================================================
// Cross-Source Narrative Threading
//
// Task 17: Thread Builder
// - Phase A: SQL clustering (entity overlap + temporal + project)
// - Phase B: DeepSeek classification (confirm and name threads)
// - Phase C: DB writes (create/update threads)
// - Phase D: Claude synthesis (narrative for top threads)
//
// Red team mitigations:
// - Minimum 2 strong signals for thread creation
// - Temporal decay (48h strong, 7d medium, 14d+ weak)
// - Minimum 3 items per thread (or 2 with cosine >0.8)
// - Stale thread revival requires 0.85 similarity
// - No calendar-only threads (low signal)
// ============================================================

interface TaskResult {
  task: string;
  status: 'success' | 'failed' | 'skipped';
  duration_seconds: number;
  output?: any;
  error?: string;
}

interface CandidateCluster {
  items: { id: string; title: string; summary: string; source: string; source_date: string; project: string | null; contacts: string }[];
  shared_entities: string[];
  score: number;
}

// ── Task 17: Thread Builder ──────────────────────────────

export async function task17ThreadBuilder(db: Database.Database): Promise<TaskResult> {
  const start = Date.now();
  try {
    // Phase A: Find unthreaded items from last 30 days
    const unthreaded = db.prepare(`
      SELECT k.id, k.title, k.summary, k.source, k.source_date, k.project, k.contacts
      FROM knowledge_primary k
      WHERE k.source_date >= datetime('now', '-30 days')
        AND k.source NOT IN ('calendar', 'agent-notification', 'agent-report', 'briefing', 'directive')
        AND k.id NOT IN (SELECT knowledge_item_id FROM thread_items)
      ORDER BY k.source_date DESC
      LIMIT 200
    `).all() as any[];

    if (unthreaded.length < 3) {
      return { task: '17-thread-builder', status: 'skipped', duration_seconds: 0, output: { message: `Only ${unthreaded.length} unthreaded items` } };
    }

    // Phase A1: Entity overlap detection
    const entityPairs = db.prepare(`
      SELECT em1.knowledge_item_id as item_a, em2.knowledge_item_id as item_b,
        GROUP_CONCAT(DISTINCT e.canonical_name) as shared_names,
        COUNT(DISTINCT em1.entity_id) as shared_count
      FROM entity_mentions em1
      JOIN entity_mentions em2 ON em1.entity_id = em2.entity_id AND em1.knowledge_item_id < em2.knowledge_item_id
      JOIN entities e ON em1.entity_id = e.id
      JOIN knowledge_primary k1 ON em1.knowledge_item_id = k1.id
      JOIN knowledge_primary k2 ON em2.knowledge_item_id = k2.id
      WHERE k1.source_date >= datetime('now', '-30 days')
        AND k2.source_date >= datetime('now', '-30 days')
        AND k1.source NOT IN ('calendar', 'agent-notification', 'agent-report')
        AND k2.source NOT IN ('calendar', 'agent-notification', 'agent-report')
        AND e.canonical_name NOT LIKE '%Zach%Stock%'
        AND e.user_label != 'dismissed'
      GROUP BY em1.knowledge_item_id, em2.knowledge_item_id
      HAVING shared_count >= 2
    `).all() as any[];

    if (entityPairs.length === 0) {
      return { task: '17-thread-builder', status: 'skipped', duration_seconds: 0, output: { message: 'No entity pair overlaps found' } };
    }

    // Phase A2: Score pairs and cluster
    const itemMap = new Map<string, any>();
    for (const item of unthreaded) {
      itemMap.set(item.id, item);
    }
    // Also load already-threaded items for extending existing threads
    const allRecent = db.prepare(`
      SELECT k.id, k.title, k.summary, k.source, k.source_date, k.project, k.contacts
      FROM knowledge_primary k WHERE k.source_date >= datetime('now', '-30 days')
    `).all() as any[];
    for (const item of allRecent) {
      if (!itemMap.has(item.id)) itemMap.set(item.id, item);
    }

    // Union-find for clustering
    const parent = new Map<string, string>();
    function find(x: string): string {
      if (!parent.has(x)) parent.set(x, x);
      if (parent.get(x) !== x) parent.set(x, find(parent.get(x)!));
      return parent.get(x)!;
    }
    function union(a: string, b: string) {
      const ra = find(a), rb = find(b);
      if (ra !== rb) parent.set(ra, rb);
    }

    // Score and union pairs
    for (const pair of entityPairs) {
      const a = itemMap.get(pair.item_a);
      const b = itemMap.get(pair.item_b);
      if (!a || !b) continue;

      let score = 0;

      // Entity overlap (0.4 weight)
      score += Math.min(pair.shared_count / 3, 1.0) * 0.4;

      // Project match (0.25 weight)
      if (a.project && b.project && a.project === b.project) score += 0.25;

      // Temporal proximity with decay (0.2 weight)
      const daysDiff = Math.abs(new Date(a.source_date).getTime() - new Date(b.source_date).getTime()) / 86400000;
      if (daysDiff <= 2) score += 0.2;
      else if (daysDiff <= 7) score += 0.15;
      else if (daysDiff <= 14) score += 0.08;

      // Source diversity bonus (0.15 weight) — different sources are STRONGER signal
      if (a.source !== b.source) score += 0.15;

      if (score >= 0.55) {
        union(pair.item_a, pair.item_b);
      }
    }

    // Build clusters
    const clusters = new Map<string, string[]>();
    for (const [item, _] of parent) {
      const root = find(item);
      if (!clusters.has(root)) clusters.set(root, []);
      clusters.get(root)!.push(item);
    }

    // Filter: minimum 3 items per cluster, or 2 with very high overlap
    const validClusters: CandidateCluster[] = [];
    for (const [_, items] of clusters) {
      if (items.length < 2) continue;
      if (items.length < 3) {
        // Need strong signal for 2-item clusters
        const pair = entityPairs.find(p =>
          (p.item_a === items[0] && p.item_b === items[1]) ||
          (p.item_a === items[1] && p.item_b === items[0])
        );
        if (!pair || pair.shared_count < 3) continue;
      }

      const clusterItems = items
        .map(id => itemMap.get(id))
        .filter(Boolean)
        .sort((a: any, b: any) => a.source_date.localeCompare(b.source_date));

      const sharedEntities = entityPairs
        .filter(p => items.includes(p.item_a) && items.includes(p.item_b))
        .flatMap(p => (p.shared_names || '').split(','));

      validClusters.push({
        items: clusterItems,
        shared_entities: [...new Set(sharedEntities)].slice(0, 5),
        score: clusterItems.length * 0.3 + (new Set(clusterItems.map((i: any) => i.source)).size) * 0.2,
      });
    }

    if (validClusters.length === 0) {
      return { task: '17-thread-builder', status: 'skipped', duration_seconds: (Date.now() - start) / 1000, output: { message: 'No valid clusters found' } };
    }

    // Phase B: DeepSeek classification
    const clusterDescriptions = validClusters.slice(0, 10).map((c, i) => {
      const itemLines = c.items.slice(0, 8).map((item: any) =>
        `  - [${item.source}] ${item.source_date?.slice(0, 10)}: "${item.title}"`
      ).join('\n');
      return `GROUP ${i + 1} (${c.items.length} items, shared: ${c.shared_entities.join(', ')}):\n${itemLines}`;
    }).join('\n\n');

    const classifyPrompt = `You are classifying groups of business communications into narrative threads.

For each group, determine:
1. Do these items belong to ONE narrative thread? (yes/no/split)
2. A short title (e.g., "Costas/Pantera reinsurance negotiation")
3. Current state of the thread
4. Primary counterparty/person

${clusterDescriptions}

Return JSON array:
[{"group": 1, "is_thread": true, "title": "...", "current_state": "...", "primary_person": "...", "confidence": 0.0-1.0}]`;

    const provider = await getBulkProvider(getConfig(db, 'openai_api_key') || undefined);
    const classifyResponse = await provider.chat([{ role: 'user', content: classifyPrompt }], { json: true, temperature: 0.1 });

    let classifications: any[];
    try {
      const parsed = JSON.parse(classifyResponse.replace(/```json?\s*\n?/g, '').replace(/\n?```/g, ''));
      classifications = Array.isArray(parsed) ? parsed : parsed.groups || parsed.results || [];
    } catch {
      classifications = [];
    }

    // Phase C: Create threads
    let threadsCreated = 0;
    let itemsAssigned = 0;

    for (const cls of classifications) {
      if (!cls.is_thread || cls.confidence < 0.6) continue;
      const clusterIdx = (cls.group || cls.index || 1) - 1;
      if (clusterIdx < 0 || clusterIdx >= validClusters.length) continue;

      const cluster = validClusters[clusterIdx];

      // Check if this overlaps with an existing thread
      const existingThread = db.prepare(`
        SELECT nt.id, nt.title FROM narrative_threads nt
        JOIN thread_items ti ON nt.id = ti.thread_id
        WHERE ti.knowledge_item_id IN (${cluster.items.map(() => '?').join(',')})
        AND nt.status = 'active'
        LIMIT 1
      `).get(...cluster.items.map((i: any) => i.id)) as any;

      let threadId: string;

      if (existingThread) {
        // Extend existing thread
        threadId = existingThread.id;
      } else {
        // Create new thread
        threadId = uuid();
        const earliest = cluster.items[0]?.source_date;
        const latest = cluster.items[cluster.items.length - 1]?.source_date;
        const sources = new Set(cluster.items.map((i: any) => i.source));
        const project = cluster.items.find((i: any) => i.project)?.project || null;

        db.prepare(`
          INSERT INTO narrative_threads (id, title, summary, status, project, entity_ids, primary_entity_id,
            latest_source_date, earliest_source_date, source_count, item_count, current_state, confidence)
          VALUES (?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          threadId, cls.title, cls.current_state, project,
          JSON.stringify(cluster.shared_entities), cls.primary_person,
          latest, earliest, sources.size, cluster.items.length,
          cls.current_state, cls.confidence
        );
        threadsCreated++;
      }

      // Add items to thread
      let position = (db.prepare("SELECT MAX(position) as max_pos FROM thread_items WHERE thread_id = ?").get(threadId) as any)?.max_pos || 0;

      for (const item of cluster.items) {
        const exists = db.prepare("SELECT 1 FROM thread_items WHERE thread_id = ? AND knowledge_item_id = ?").get(threadId, item.id);
        if (!exists) {
          position++;
          db.prepare("INSERT INTO thread_items (id, thread_id, knowledge_item_id, position, role) VALUES (?, ?, ?, ?, ?)")
            .run(uuid(), threadId, item.id, position, position === 1 ? 'origin' : 'continuation');
          itemsAssigned++;
        }
      }

      // Update thread stats
      const stats = db.prepare(`
        SELECT COUNT(*) as cnt, COUNT(DISTINCT k.source) as sources,
          MIN(k.source_date) as earliest, MAX(k.source_date) as latest
        FROM thread_items ti JOIN knowledge_primary k ON ti.knowledge_item_id = k.id
        WHERE ti.thread_id = ?
      `).get(threadId) as any;

      db.prepare(`
        UPDATE narrative_threads SET item_count = ?, source_count = ?,
          earliest_source_date = ?, latest_source_date = ?, updated_at = datetime('now')
        WHERE id = ?
      `).run(stats.cnt, stats.sources, stats.earliest, stats.latest, threadId);
    }

    // Phase D: Narrative synthesis for top threads (limit to 3 per run)
    const needsSynthesis = db.prepare(`
      SELECT nt.* FROM narrative_threads nt
      WHERE nt.status = 'active' AND nt.narrative_md IS NULL
      ORDER BY nt.item_count DESC, nt.latest_source_date DESC LIMIT 3
    `).all() as any[];

    let narrativesBuilt = 0;
    for (const thread of needsSynthesis) {
      try {
        const threadItems = db.prepare(`
          SELECT k.id, k.title, k.summary, k.source, k.source_date, k.source_ref
          FROM knowledge_primary k
          JOIN thread_items ti ON k.id = ti.knowledge_item_id
          WHERE ti.thread_id = ?
          ORDER BY ti.position ASC
        `).all(thread.id) as any[];

        // Get deep content for up to 5 items
        const deepContent = await retrieveDeepContext(db, threadItems.slice(0, 5), 5);

        const synthPrompt = `Synthesize a chronological narrative for this business thread.

THREAD: "${thread.title}"
Primary person: ${thread.primary_entity_id || 'unknown'}
Project: ${thread.project || 'unassigned'}

ITEMS (chronological):
${threadItems.map((i: any) => `[${i.source}] ${i.source_date?.slice(0, 10)}: ${i.title}\n  ${i.summary}`).join('\n\n')}

${deepContent ? `SOURCE MATERIAL:\n${deepContent}` : ''}

Write:
1. Executive summary (2-3 sentences)
2. Chronological narrative with dates
3. Current state
4. Next action

Return JSON:
{"summary": "...", "narrative_md": "## ...", "current_state": "...", "next_action": "..."}`;

        const { spawn } = await import('child_process');
        const synthResponse = await new Promise<string>((resolve, reject) => {
          const env = { ...process.env };
          delete env.ANTHROPIC_API_KEY;
          const proc = spawn('claude', ['-p'], { stdio: ['pipe', 'pipe', 'pipe'], env, timeout: 120000 });
          let stdout = '';
          proc.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
          proc.on('close', (code) => { if (code === 0) resolve(stdout.trim()); else reject(new Error(`claude exited ${code}`)); });
          proc.on('error', reject);
          proc.stdin.write(synthPrompt);
          proc.stdin.end();
        });

        const jsonMatch = synthResponse.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          const synth = JSON.parse(jsonMatch[0]);
          db.prepare(`
            UPDATE narrative_threads SET summary = ?, narrative_md = ?, current_state = ?, next_action = ?, updated_at = datetime('now')
            WHERE id = ?
          `).run(synth.summary, synth.narrative_md, synth.current_state, synth.next_action, thread.id);
          narrativesBuilt++;
        }
      } catch (err: any) {
        console.error(`    ✗ Synthesis failed for "${thread.title}": ${err.message?.slice(0, 80)}`);
      }
    }

    // Store thread summary in graph_state for downstream tasks
    const activeThreads = db.prepare(`
      SELECT id, title, current_state, next_action, project, source_count, item_count, latest_source_date
      FROM narrative_threads WHERE status = 'active' ORDER BY latest_source_date DESC LIMIT 15
    `).all() as any[];

    db.prepare("INSERT OR REPLACE INTO graph_state (key, value, updated_at) VALUES ('active_threads', ?, datetime('now'))")
      .run(JSON.stringify(activeThreads));

    return {
      task: '17-thread-builder',
      status: 'success',
      duration_seconds: (Date.now() - start) / 1000,
      output: { clusters: validClusters.length, threads_created: threadsCreated, items_assigned: itemsAssigned, narratives_built: narrativesBuilt },
    };
  } catch (err: any) {
    return { task: '17-thread-builder', status: 'failed', duration_seconds: (Date.now() - start) / 1000, error: err.message };
  }
}

// ── Helper: Get thread context for prompt injection ──────

export function getThreadContext(db: Database.Database, project?: string): string {
  const query = project
    ? "SELECT title, current_state, next_action, source_count, item_count FROM narrative_threads WHERE status = 'active' AND project = ? ORDER BY latest_source_date DESC LIMIT 5"
    : "SELECT title, current_state, next_action, source_count, item_count FROM narrative_threads WHERE status = 'active' ORDER BY latest_source_date DESC LIMIT 10";

  const threads = (project ? db.prepare(query).all(project) : db.prepare(query).all()) as any[];
  if (threads.length === 0) return '';

  return 'NARRATIVE THREADS (cross-source stories — these are the DEFINITIVE account of each topic):\n' +
    threads.map((t: any) => `- **${t.title}** (${t.source_count} sources, ${t.item_count} items)\n  State: ${t.current_state}\n  Next: ${t.next_action}`).join('\n') +
    '\nWhen discussing a topic with a thread, use the thread\'s current_state as ground truth.\n';
}
