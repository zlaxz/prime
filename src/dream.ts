import type Database from 'better-sqlite3';
import { spawn } from 'child_process';
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { getDb, getConfig } from './db.js';
import { generateWorldModel, saveWorldModel, worldModelToMarkdown } from './ai/world.js';
import { getAlerts } from './ai/intelligence.js';
import { buildEntityGraph } from './entities.js';

// ============================================================
// Dream State Pipeline — Phase 5 of v1.0 Brain Architecture
//
// dream.ts is the ORCHESTRATOR. claude -p is the reasoning engine.
// Each task: pre-query DB → assemble prompt → claude -p → validate → apply.
// ============================================================

const DREAM_DIR = join(homedir(), '.prime', 'dream');
const RESULTS_DIR = join(DREAM_DIR, 'results');
const LOGS_DIR = join(homedir(), '.prime', 'logs', 'dream');

interface TaskResult {
  task: string;
  status: 'success' | 'failed' | 'skipped';
  duration_seconds: number;
  output?: any;
  error?: string;
}

function ensureDirs() {
  for (const dir of [DREAM_DIR, RESULTS_DIR, LOGS_DIR]) {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  }
}

// ── claude -p invocation ────────────────────────────────────

async function callClaude(prompt: string, timeoutMs: number = 300000): Promise<string> {
  return new Promise((resolve, reject) => {
    const env = { ...process.env };
    delete env.ANTHROPIC_API_KEY; // Force Max subscription OAuth

    const proc = spawn('claude', ['-p', '--model', 'sonnet'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env,
      timeout: timeoutMs,
    });

    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
    proc.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });

    proc.on('close', (code) => {
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(`claude -p exited ${code}: ${stderr.slice(0, 300)}`));
    });
    proc.on('error', (err) => reject(err));

    proc.stdin.write(prompt);
    proc.stdin.end();
  });
}

function tryParseJSON(text: string): any {
  // Strip markdown code fences
  const cleaned = text.replace(/^```(?:json)?\s*\n?/m, '').replace(/\n?```\s*$/m, '').trim();
  try { return JSON.parse(cleaned); } catch {}
  // Try finding JSON array in the text
  const arrayMatch = text.match(/\[[\s\S]*\]/);
  if (arrayMatch) { try { return JSON.parse(arrayMatch[0]); } catch {} }
  // Try finding JSON object in the text
  const objMatch = text.match(/\{[\s\S]*\}/);
  if (objMatch) { try { return JSON.parse(objMatch[0]); } catch {} }
  return null;
}

// ── Dream Tasks ─────────────────────────────────────────────

async function task01Consolidate(db: Database.Database): Promise<TaskResult> {
  const start = Date.now();
  try {
    // Pre-query: new items since last dream
    const lastRun = (db.prepare("SELECT value FROM graph_state WHERE key = 'last_dream_run'").get() as any)?.value || '2000-01-01';
    const newItems = db.prepare(`
      SELECT id, title, summary, source, source_date, contacts, organizations, project, tags, metadata
      FROM knowledge WHERE source_date > ? AND source NOT IN ('agent-report','agent-notification','briefing')
      ORDER BY source_date DESC LIMIT 50
    `).all(lastRun) as any[];

    if (newItems.length === 0) {
      return { task: '01-consolidate', status: 'skipped', duration_seconds: 0, output: { reason: 'no new items' } };
    }

    // Run incremental entity build (no LLM needed)
    const entityStats = buildEntityGraph(db, { incremental: true });

    // Process directives for implicit learning signals
    const { recordSignal } = await import('./entities.js');
    const directives = newItems.filter((item: any) => {
      const tags = typeof item.tags === 'string' ? JSON.parse(item.tags) : (item.tags || []);
      return tags.includes('directive') || item.source === 'directive';
    });

    let signalsRecorded = 0;
    for (const directive of directives) {
      const meta = typeof directive.metadata === 'string' ? JSON.parse(directive.metadata) : (directive.metadata || {});
      const decisions = typeof directive.decisions === 'string' ? JSON.parse(directive.decisions) : (directive.decisions || []);

      for (const decision of decisions) {
        const lower = decision.toLowerCase();
        // Extract entity name from the decision text
        const contacts = typeof directive.contacts === 'string' ? JSON.parse(directive.contacts) : (directive.contacts || []);

        for (const contact of contacts) {
          if (lower.includes('dismiss') || lower.includes('ignore') || lower.includes('skip')) {
            recordSignal(db, contact, 'alert_ignored');
            signalsRecorded++;
          } else if (lower.includes('approv') || lower.includes('send') || lower.includes('call') || lower.includes('respond')) {
            recordSignal(db, contact, 'alert_acted');
            signalsRecorded++;
          }
        }
      }
    }

    return {
      task: '01-consolidate',
      status: 'success',
      duration_seconds: (Date.now() - start) / 1000,
      output: { items_processed: newItems.length, ...entityStats },
    };
  } catch (err: any) {
    return { task: '01-consolidate', status: 'failed', duration_seconds: (Date.now() - start) / 1000, error: err.message };
  }
}

async function task02EntityClassify(db: Database.Database): Promise<TaskResult> {
  const start = Date.now();
  try {
    // Get entities needing classification
    const toClassify = db.prepare(`
      SELECT e.id, e.canonical_name, e.email, e.domain, e.relationship_type, e.relationship_confidence,
        COUNT(em.id) as mentions,
        SUM(CASE WHEN em.direction = 'inbound' THEN 1 ELSE 0 END) as inbound,
        SUM(CASE WHEN em.direction = 'outbound' THEN 1 ELSE 0 END) as outbound
      FROM entities e
      LEFT JOIN entity_mentions em ON e.id = em.entity_id
      WHERE e.user_dismissed = 0 AND e.user_label IS NULL AND e.type = 'person'
        AND (e.relationship_confidence < 0.7 OR e.relationship_type IS NULL)
      GROUP BY e.id
      HAVING mentions >= 5
      ORDER BY mentions DESC LIMIT 20
    `).all() as any[];

    if (toClassify.length === 0) {
      return { task: '02-entity-classify', status: 'skipped', duration_seconds: 0, output: { reason: 'all entities classified' } };
    }

    // Get user-labeled entities as examples
    const labeled = db.prepare(`
      SELECT canonical_name, user_label FROM entities WHERE user_label IS NOT NULL
    `).all() as any[];

    const prompt = `Classify business contacts by relationship type. Return ONLY a JSON array — no explanation, no markdown, no text before or after.

Known labels (DO NOT contradict):
${labeled.map((l: any) => `${l.canonical_name} = ${l.user_label}`).join(', ')}

People to classify:
${toClassify.map((e: any) => `${e.canonical_name}${e.email ? ` <${e.email}>` : ''} | ${e.mentions} mentions | ${e.inbound} in ${e.outbound} out${e.domain ? ` | ${e.domain}` : ''}`).join('\n')}

Classification guide:
- employee: high inbound, work topics, same org domain as user
- partner: bidirectional, deal/business topics, external org
- client: user provides services, invoices sent
- vendor: provides services to user, invoices received
- advisor: occasional, strategic, user seeks advice
- broker: intermediary, connects parties
- noise: single interaction, cold outreach, no response
- unknown: insufficient data (use confidence < 0.5)

Return ONLY this JSON (no other text):
[{"name":"...","type":"...","confidence":0.8,"reasoning":"..."}]`;

    const response = await callClaude(prompt, 120000);
    const parsed = tryParseJSON(response);

    if (parsed && Array.isArray(parsed)) {
      let classified = 0;
      for (const item of parsed) {
        if (item.name && item.type && item.confidence >= 0.5) {
          db.prepare(`
            UPDATE entities SET relationship_type = ?, relationship_confidence = ?, updated_at = datetime('now')
            WHERE canonical_name = ? AND user_label IS NULL
          `).run(item.type, item.confidence, item.name);
          classified++;
        }
      }
      return { task: '02-entity-classify', status: 'success', duration_seconds: (Date.now() - start) / 1000, output: { classified, total: toClassify.length } };
    }

    return { task: '02-entity-classify', status: 'failed', duration_seconds: (Date.now() - start) / 1000, error: 'Could not parse classification response' };
  } catch (err: any) {
    return { task: '02-entity-classify', status: 'failed', duration_seconds: (Date.now() - start) / 1000, error: err.message };
  }
}

async function task03CommitmentCheck(db: Database.Database): Promise<TaskResult> {
  const start = Date.now();
  try {
    const active = db.prepare(`
      SELECT id, text, owner, assigned_to, due_date, state, project FROM commitments
      WHERE state IN ('active', 'detected') ORDER BY due_date ASC
    `).all() as any[];

    const now = new Date().toISOString();
    let newOverdue = 0;

    for (const c of active) {
      if (c.due_date && c.due_date < now && c.state !== 'overdue') {
        db.prepare("UPDATE commitments SET state = 'overdue', state_changed_at = datetime('now') WHERE id = ?").run(c.id);
        newOverdue++;
      }
    }

    return { task: '03-commitment-check', status: 'success', duration_seconds: (Date.now() - start) / 1000, output: { checked: active.length, new_overdue: newOverdue } };
  } catch (err: any) {
    return { task: '03-commitment-check', status: 'failed', duration_seconds: (Date.now() - start) / 1000, error: err.message };
  }
}

async function task04WorldRebuild(db: Database.Database): Promise<TaskResult> {
  const start = Date.now();
  try {
    const model = generateWorldModel(db);
    saveWorldModel(model);
    return {
      task: '04-world-rebuild',
      status: 'success',
      duration_seconds: (Date.now() - start) / 1000,
      output: { people: model.people.length, projects: model.projects.length, alerts: model.alerts.length },
    };
  } catch (err: any) {
    return { task: '04-world-rebuild', status: 'failed', duration_seconds: (Date.now() - start) / 1000, error: err.message };
  }
}

async function task05SelfAudit(db: Database.Database): Promise<TaskResult> {
  const start = Date.now();
  try {
    // Get yesterday's agent reports
    const reports = db.prepare(`
      SELECT title, summary, metadata FROM knowledge
      WHERE source = 'agent-report' AND source_date >= datetime('now', '-1 day')
      ORDER BY source_date DESC LIMIT 3
    `).all() as any[];

    if (reports.length === 0) {
      return { task: '05-self-audit', status: 'skipped', duration_seconds: 0, output: { reason: 'no recent reports to audit' } };
    }

    // Get current alerts for ground truth
    const alerts = getAlerts(db);

    const reportText = reports.map((r: any) => {
      const meta = typeof r.metadata === 'string' ? JSON.parse(r.metadata) : (r.metadata || {});
      return `REPORT: ${r.title}\n${meta.full_report || r.summary}`;
    }).join('\n\n---\n\n');

    const prompt = `Audit these agent reports for accuracy. Compare claims against the ground truth alerts below.

AGENT REPORTS:
${reportText.slice(0, 4000)}

GROUND TRUTH ALERTS (${alerts.length} total):
${alerts.slice(0, 30).map(a => `[${a.severity}] ${a.title}: ${a.detail}`).join('\n')}

Return JSON:
{
  "reports_audited": N,
  "total_claims": N,
  "accurate_claims": N,
  "hallucinated_claims": N,
  "overall_accuracy": 0.0-1.0,
  "issues": [{"claim": "...", "problem": "...", "severity": "high|medium|low"}],
  "recommendations": ["..."]
}`;

    const response = await callClaude(prompt, 180000);
    const parsed = tryParseJSON(response);

    if (parsed && parsed.overall_accuracy !== undefined) {
      // Save accuracy score for tracking over time
      const dateStr = new Date().toISOString().slice(0, 10);
      const existingScores = (db.prepare("SELECT value FROM graph_state WHERE key = 'accuracy_history'").get() as any)?.value || '[]';
      const scores = JSON.parse(existingScores);
      scores.push({ date: dateStr, accuracy: parsed.overall_accuracy, hallucination_rate: parsed.hallucinated_claims || 0, issues: parsed.issues?.length || 0 });
      // Keep last 90 days
      const recent = scores.filter((s: any) => new Date(s.date) > new Date(Date.now() - 90 * 86400000));
      db.prepare("INSERT OR REPLACE INTO graph_state (key, value, updated_at) VALUES ('accuracy_history', ?, datetime('now'))").run(JSON.stringify(recent));

      return { task: '05-self-audit', status: 'success', duration_seconds: (Date.now() - start) / 1000, output: parsed };
    }

    return { task: '05-self-audit', status: 'success', duration_seconds: (Date.now() - start) / 1000, output: { raw: response.slice(0, 500) } };
  } catch (err: any) {
    return { task: '05-self-audit', status: 'failed', duration_seconds: (Date.now() - start) / 1000, error: err.message };
  }
}

// ── Task 06: Entity Understanding — THE intelligence layer ──
// Sends full context to claude -p. No regex. No heuristics.
// The LLM reads every email and makes a judgment call.

async function task06EntityUnderstanding(db: Database.Database): Promise<TaskResult> {
  const start = Date.now();
  try {
    // Get all entities with open (awaiting_reply) threads that don't have
    // a user-override profile already
    const candidates = db.prepare(`
      SELECT DISTINCT e.id, e.canonical_name, e.email, e.domain,
        e.user_label, e.relationship_type
      FROM entities e
      JOIN entity_mentions em ON e.id = em.entity_id
      JOIN knowledge k ON em.knowledge_item_id = k.id
      WHERE k.tags LIKE '%awaiting_reply%'
        AND e.user_dismissed = 0
        AND e.type = 'person'
        AND e.canonical_name NOT LIKE '%Zach%Stock%'
        AND (e.user_label IS NULL OR e.user_label NOT IN ('employee', 'noise'))
    `).all() as any[];

    // Filter out entities that already have a fresh, user-confirmed profile
    const needsEval = candidates.filter((c: any) => {
      const profile = db.prepare(
        'SELECT user_override, last_verified_at FROM entity_profiles WHERE entity_id = ?'
      ).get(c.id) as any;
      if (profile?.user_override) return false;
      // Re-evaluate if no profile or older than 7 days
      if (!profile?.last_verified_at) return true;
      const age = Date.now() - new Date(profile.last_verified_at).getTime();
      return age > 7 * 86400000;
    });

    if (needsEval.length === 0) {
      return { task: '06-entity-understanding', status: 'skipped', duration_seconds: 0, output: { reason: 'all entities profiled' } };
    }

    console.log(`    Evaluating ${needsEval.length} entities with LLM...`);

    // Process in batches of 5 entities per LLM call
    const BATCH_SIZE = 5;
    let evaluated = 0;
    let surfaced = 0;
    let suppressed = 0;

    for (let i = 0; i < needsEval.length; i += BATCH_SIZE) {
      const batch = needsEval.slice(i, i + BATCH_SIZE);

      // Build rich context for each entity in the batch
      const entityContexts = batch.map((entity: any) => {
        // Get ALL items involving this entity (titles, summaries, dates, direction)
        const items = db.prepare(`
          SELECT k.title, k.summary, k.source, k.source_date, k.tags, k.project,
                 em.direction, em.role,
                 json_extract(k.metadata, '$.last_from') as last_from
          FROM knowledge k
          JOIN entity_mentions em ON k.id = em.knowledge_item_id
          WHERE em.entity_id = ?
          ORDER BY k.source_date DESC
        `).all(entity.id) as any[];

        // Get open threads specifically
        const openThreads = items.filter((it: any) => {
          const tags = typeof it.tags === 'string' ? JSON.parse(it.tags) : (it.tags || []);
          return tags.includes('awaiting_reply');
        });

        // Get communication stats
        const stats = db.prepare(`
          SELECT COUNT(*) as total,
            SUM(CASE WHEN direction = 'inbound' THEN 1 ELSE 0 END) as inbound,
            SUM(CASE WHEN direction = 'outbound' THEN 1 ELSE 0 END) as outbound,
            MIN(mention_date) as first_seen,
            MAX(mention_date) as last_seen
          FROM entity_mentions WHERE entity_id = ?
        `).get(entity.id) as any;

        const itemLines = items.slice(0, 15).map((it: any) => {
          const tags = typeof it.tags === 'string' ? JSON.parse(it.tags) : (it.tags || []);
          const isOpen = tags.includes('awaiting_reply') ? ' [AWAITING REPLY]' : '';
          return `  ${it.source_date?.slice(0, 10) || '?'} | ${it.source} | ${it.direction || '?'} | ${it.title}${isOpen}`;
        }).join('\n');

        const openLines = openThreads.slice(0, 5).map((it: any) =>
          `  - "${it.title}" (${it.source_date?.slice(0, 10) || '?'})`
        ).join('\n');

        return `
ENTITY: ${entity.canonical_name}
Email: ${entity.email || 'unknown'}
Domain: ${entity.domain || 'unknown'}
Current label: ${entity.user_label || entity.relationship_type || 'none'}
Total interactions: ${stats?.total || 0} (${stats?.inbound || 0} inbound, ${stats?.outbound || 0} outbound)
First seen: ${stats?.first_seen?.slice(0, 10) || '?'} | Last seen: ${stats?.last_seen?.slice(0, 10) || '?'}
Open threads (awaiting reply): ${openThreads.length}
${openLines || '  (none)'}

All communications (most recent first):
${itemLines || '  (none)'}
`;
      }).join('\n---\n');

      const prompt = `You are evaluating business contacts for an AI Chief of Staff system. The user is Zach Stock, founder of Recapture Insurance (an MGA/insurance company).

For each entity below, analyze their ENTIRE communication history and determine:
1. What is this person's actual relationship to Zach's business?
2. What kind of emails do they send? (transactional like invoices/policies, relational like meetings/discussions, informational like notifications, or spam like cold outreach)
3. Do any of their "awaiting reply" threads ACTUALLY need a reply from Zach?
4. Should the system surface alerts about this person, or stay silent?

Think like a human executive assistant who has read every email. If a person only sends invoices and policy documents, they don't need replies flagged. If someone sent a meeting request 25 days ago and Zach never responded, that MIGHT need attention — but only if the relationship matters.

ENTITIES TO EVALUATE:
${entityContexts}

Return ONLY this JSON array (no other text):
[
  {
    "name": "Full Name",
    "relationship": "partner|client|vendor|carrier|broker|advisor|employee|cold_outreach|automated|unknown",
    "communication_nature": "transactional|relational|strategic|informational|spam",
    "reply_needed": true/false,
    "reply_reasoning": "Why or why not a reply is needed — be specific",
    "alert_verdict": "surface|suppress",
    "verdict_reasoning": "Why surface or suppress — reference specific emails",
    "importance": "critical|high|medium|low|none",
    "confidence": 0.0-1.0
  }
]`;

      try {
        const response = await callClaude(prompt, 180000);
        const parsed = tryParseJSON(response);

        if (parsed && Array.isArray(parsed)) {
          for (const item of parsed) {
            if (!item.name || !item.alert_verdict) continue;

            // Find matching entity
            const matchEntity = batch.find((e: any) =>
              e.canonical_name.toLowerCase() === item.name.toLowerCase()
            );
            if (!matchEntity) continue;

            // Map LLM reply_expectation from reply_needed
            const replyExp = item.reply_needed ? 'sometimes' :
              item.communication_nature === 'spam' ? 'never' :
              item.communication_nature === 'transactional' ? 'rarely' : 'unknown';

            // Store profile
            db.prepare(`
              INSERT INTO entity_profiles (entity_id, communication_nature, reply_expectation,
                email_types, importance_to_business, importance_evidence,
                relationship_evidence, alert_verdict, verdict_reasoning,
                verdict_confidence, last_verified_at, updated_at)
              VALUES (?, ?, ?, '[]', ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
              ON CONFLICT(entity_id) DO UPDATE SET
                communication_nature = excluded.communication_nature,
                reply_expectation = excluded.reply_expectation,
                importance_to_business = excluded.importance_to_business,
                importance_evidence = excluded.importance_evidence,
                relationship_evidence = excluded.relationship_evidence,
                alert_verdict = excluded.alert_verdict,
                verdict_reasoning = excluded.verdict_reasoning,
                verdict_confidence = excluded.verdict_confidence,
                last_verified_at = excluded.last_verified_at,
                updated_at = excluded.updated_at
            `).run(
              matchEntity.id,
              item.communication_nature || 'unknown',
              replyExp,
              item.importance || 'unknown',
              item.verdict_reasoning || '',
              item.reply_reasoning || '',
              item.alert_verdict,
              item.verdict_reasoning || '',
              item.confidence || 0.5,
            );

            // Also update entity relationship_type if AI provides one and user hasn't set it
            if (item.relationship && !matchEntity.user_label) {
              db.prepare(`
                UPDATE entities SET relationship_type = ?, relationship_confidence = ?,
                  updated_at = datetime('now')
                WHERE id = ? AND user_label IS NULL
              `).run(item.relationship, item.confidence || 0.5, matchEntity.id);
            }

            evaluated++;
            if (item.alert_verdict === 'surface') surfaced++;
            else suppressed++;
          }
        }
      } catch (err: any) {
        console.log(`    Batch ${i / BATCH_SIZE + 1} failed: ${err.message.slice(0, 100)}`);
      }

      // Progress
      console.log(`    Batch ${Math.floor(i / BATCH_SIZE) + 1}/${Math.ceil(needsEval.length / BATCH_SIZE)}: ${evaluated} evaluated`);
    }

    return {
      task: '06-entity-understanding',
      status: 'success',
      duration_seconds: (Date.now() - start) / 1000,
      output: { evaluated, surfaced, suppressed, total_candidates: needsEval.length },
    };
  } catch (err: any) {
    return { task: '06-entity-understanding', status: 'failed', duration_seconds: (Date.now() - start) / 1000, error: err.message };
  }
}

// ── Pipeline Runner ─────────────────────────────────────────

export async function runDreamPipeline(
  options: { quick?: boolean } = {}
): Promise<{ tasks: TaskResult[]; total_duration: number }> {
  ensureDirs();
  const db = getDb();
  const start = Date.now();
  const results: TaskResult[] = [];
  const dateStr = new Date().toISOString().slice(0, 10);
  const resultsDir = join(RESULTS_DIR, dateStr);
  if (!existsSync(resultsDir)) mkdirSync(resultsDir, { recursive: true });

  console.log(`\n⚡ DREAM PIPELINE — ${new Date().toLocaleString()}\n`);

  // Task 01: Consolidate
  console.log('  Task 01: Consolidate new signals...');
  const r01 = await task01Consolidate(db);
  results.push(r01);
  console.log(`    ${r01.status === 'success' ? '✓' : r01.status === 'skipped' ? '○' : '✗'} ${r01.status} (${r01.duration_seconds.toFixed(1)}s)${r01.output ? ` — ${JSON.stringify(r01.output).slice(0, 100)}` : ''}`);

  // Task 02: Entity classify (skip in quick mode)
  if (!options.quick) {
    console.log('  Task 02: Classify entities...');
    const r02 = await task02EntityClassify(db);
    results.push(r02);
    console.log(`    ${r02.status === 'success' ? '✓' : r02.status === 'skipped' ? '○' : '✗'} ${r02.status} (${r02.duration_seconds.toFixed(1)}s)${r02.output ? ` — ${JSON.stringify(r02.output).slice(0, 100)}` : ''}`);
  }

  // Task 03: Commitment check
  console.log('  Task 03: Check commitments...');
  const r03 = await task03CommitmentCheck(db);
  results.push(r03);
  console.log(`    ${r03.status === 'success' ? '✓' : '✗'} ${r03.status} (${r03.duration_seconds.toFixed(1)}s)${r03.output ? ` — ${JSON.stringify(r03.output).slice(0, 100)}` : ''}`);

  // Task 06: Entity Understanding (LLM-powered, skip in quick mode)
  if (!options.quick) {
    console.log('  Task 06: Entity understanding (LLM)...');
    const r06 = await task06EntityUnderstanding(db);
    results.push(r06);
    console.log(`    ${r06.status === 'success' ? '✓' : r06.status === 'skipped' ? '○' : '✗'} ${r06.status} (${r06.duration_seconds.toFixed(1)}s)${r06.output ? ` — ${JSON.stringify(r06.output).slice(0, 100)}` : ''}`);
  }

  // Task 04: World rebuild (AFTER entity understanding, so world model uses fresh profiles)
  console.log('  Task 04: Rebuild world model...');
  const r04 = await task04WorldRebuild(db);
  results.push(r04);
  console.log(`    ${r04.status === 'success' ? '✓' : '✗'} ${r04.status} (${r04.duration_seconds.toFixed(1)}s)${r04.output ? ` — ${JSON.stringify(r04.output).slice(0, 100)}` : ''}`);

  // Task 05: Self-audit (skip in quick mode)
  if (!options.quick) {
    console.log('  Task 05: Self-audit...');
    const r05 = await task05SelfAudit(db);
    results.push(r05);
    console.log(`    ${r05.status === 'success' ? '✓' : r05.status === 'skipped' ? '○' : '✗'} ${r05.status} (${r05.duration_seconds.toFixed(1)}s)${r05.output?.overall_accuracy !== undefined ? ` — accuracy: ${(r05.output.overall_accuracy * 100).toFixed(0)}%` : ''}`);
  }

  // Update last dream run timestamp
  db.prepare("INSERT OR REPLACE INTO graph_state (key, value, updated_at) VALUES ('last_dream_run', ?, datetime('now'))")
    .run(new Date().toISOString());

  const totalDuration = (Date.now() - start) / 1000;

  // Save results
  const summary = {
    date: dateStr,
    mode: options.quick ? 'quick' : 'full',
    total_duration_seconds: totalDuration,
    tasks: results,
    health: {
      succeeded: results.filter(r => r.status === 'success').length,
      failed: results.filter(r => r.status === 'failed').length,
      skipped: results.filter(r => r.status === 'skipped').length,
    },
  };

  writeFileSync(join(resultsDir, 'summary.json'), JSON.stringify(summary, null, 2));

  console.log(`\n  ────────────────────────────────────`);
  console.log(`  ✓ Dream pipeline complete: ${summary.health.succeeded}/${results.length} tasks (${totalDuration.toFixed(1)}s)`);
  if (summary.health.failed > 0) console.log(`  ⚠ ${summary.health.failed} tasks failed`);
  console.log('');

  return { tasks: results, total_duration: totalDuration };
}
