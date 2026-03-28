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

    const proc = spawn('claude', ['-p'], {
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
      FROM knowledge_primary WHERE source_date > ?
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
      SELECT title, summary, metadata FROM knowledge_derived
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
    // Evaluate ALL active entities — not just those with open threads.
    // Important relationships need monitoring even when no email is pending.
    // This REPLACES task 02 (shallow classification) with deep understanding.
    const candidates = db.prepare(`
      SELECT e.id, e.canonical_name, e.email, e.domain,
        e.user_label, e.relationship_type,
        COUNT(em.id) as mention_count,
        MAX(em.mention_date) as last_seen
      FROM entities e
      LEFT JOIN entity_mentions em ON e.id = em.entity_id
      WHERE e.user_dismissed = 0
        AND e.type = 'person'
        AND e.canonical_name NOT LIKE '%Zach%Stock%'
        AND (e.user_label IS NULL OR e.user_label NOT IN ('employee', 'noise'))
      GROUP BY e.id
      HAVING mention_count >= 3
      ORDER BY mention_count DESC
      LIMIT 60
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

      // Build DEEP context for each entity — not just titles, but the full intelligence
      const entityContexts = batch.map((entity: any) => {
        // Get ALL items with FULL extracted intelligence
        const items = db.prepare(`
          SELECT k.title, k.summary, k.source, k.source_date, k.tags, k.project,
                 k.contacts, k.commitments, k.decisions, k.action_items, k.importance,
                 em.direction, em.role,
                 json_extract(k.metadata, '$.last_from') as last_from
          FROM knowledge_primary k
          JOIN entity_mentions em ON k.id = em.knowledge_item_id
          WHERE em.entity_id = ?
          ORDER BY k.source_date DESC
        `).all(entity.id) as any[];

        // Open threads
        const openThreads = items.filter((it: any) => {
          const tags = typeof it.tags === 'string' ? JSON.parse(it.tags) : (it.tags || []);
          return tags.includes('awaiting_reply');
        });

        // Communication stats
        const stats = db.prepare(`
          SELECT COUNT(*) as total,
            SUM(CASE WHEN direction = 'inbound' THEN 1 ELSE 0 END) as inbound,
            SUM(CASE WHEN direction = 'outbound' THEN 1 ELSE 0 END) as outbound,
            MIN(mention_date) as first_seen,
            MAX(mention_date) as last_seen
          FROM entity_mentions WHERE entity_id = ?
        `).get(entity.id) as any;

        // CROSS-ENTITY: who do they co-occur with? (relationship web)
        const connections = db.prepare(`
          SELECT e2.canonical_name, e2.user_label, e2.relationship_type,
            ee.co_occurrence_count, ee.edge_type
          FROM entity_edges ee
          JOIN entities e2 ON (CASE WHEN ee.source_entity_id = ? THEN ee.target_entity_id ELSE ee.source_entity_id END = e2.id)
          WHERE (ee.source_entity_id = ? OR ee.target_entity_id = ?)
            AND e2.user_dismissed = 0 AND e2.canonical_name NOT LIKE '%Zach%Stock%'
          ORDER BY ee.co_occurrence_count DESC LIMIT 5
        `).all(entity.id, entity.id, entity.id) as any[];

        // Open commitments involving this person
        const commitments = db.prepare(`
          SELECT text, state, due_date FROM commitments
          WHERE (owner LIKE ? OR assigned_to LIKE ?) AND state IN ('active', 'overdue')
        `).all(`%${entity.canonical_name}%`, `%${entity.canonical_name}%`) as any[];

        // Build RICH item lines with extracted intelligence
        const itemLines = items.slice(0, 20).map((it: any) => {
          const tags = typeof it.tags === 'string' ? JSON.parse(it.tags) : (it.tags || []);
          const isOpen = tags.includes('awaiting_reply') ? ' [AWAITING REPLY]' : '';
          const extractedCommitments = typeof it.commitments === 'string' ? JSON.parse(it.commitments || '[]') : (it.commitments || []);
          const extractedDecisions = typeof it.decisions === 'string' ? JSON.parse(it.decisions || '[]') : (it.decisions || []);
          const extractedActions = typeof it.action_items === 'string' ? JSON.parse(it.action_items || '[]') : (it.action_items || []);

          let line = `  ${it.source_date?.slice(0, 10) || '?'} | ${it.source} | ${it.direction || '?'} | ${it.title}${isOpen}`;
          line += `\n    Summary: ${(it.summary || '').slice(0, 150)}`;
          if (extractedCommitments.length) line += `\n    Commitments: ${extractedCommitments.slice(0, 2).join('; ')}`;
          if (extractedDecisions.length) line += `\n    Decisions: ${extractedDecisions.slice(0, 2).join('; ')}`;
          if (extractedActions.length) line += `\n    Action items: ${extractedActions.slice(0, 2).join('; ')}`;
          return line;
        }).join('\n');

        const connectionLines = connections.map((c: any) =>
          `  ${c.canonical_name} [${c.user_label || c.relationship_type || '?'}] (${c.co_occurrence_count} shared items)`
        ).join('\n');

        const commitmentLines = commitments.map((c: any) =>
          `  - ${c.text} [${c.state}]${c.due_date ? ' due: ' + c.due_date : ''}`
        ).join('\n');

        // Projects this person ACTUALLY appears in (from data, not assumption)
        const actualProjects = db.prepare(`
          SELECT DISTINCT k.project, COUNT(*) as cnt FROM knowledge_primary k
          JOIN entity_mentions em ON k.id = em.knowledge_item_id
          WHERE em.entity_id = ? AND k.project IS NOT NULL AND k.project != ''
          GROUP BY k.project ORDER BY cnt DESC
        `).all(entity.id) as any[];
        const projectLine = actualProjects.map((p: any) => `${p.project} (${p.cnt} items)`).join(', ');

        return `
ENTITY: ${entity.canonical_name}
Email: ${entity.email || 'unknown'}
Domain: ${entity.domain || 'unknown'}
Current label: ${entity.user_label || entity.relationship_type || 'none'}
Total interactions: ${stats?.total || 0} (${stats?.inbound || 0} inbound, ${stats?.outbound || 0} outbound)
First seen: ${stats?.first_seen?.slice(0, 10) || '?'} | Last seen: ${stats?.last_seen?.slice(0, 10) || '?'}
PROJECTS (from data): ${projectLine || '(none)'}
Open threads: ${openThreads.length}
Connected to: ${connections.length > 0 ? '\n' + connectionLines : '(no connections)'}
Open commitments: ${commitments.length > 0 ? '\n' + commitmentLines : '(none)'}

All communications (most recent first):
${itemLines || '  (none)'}
`;
      }).join('\n---\n');

      // Load business context if available
      const businessCtx = getConfig(db, 'business_context') || '';

      // Load USER CORRECTIONS as hard constraints
      const userLabeled = db.prepare(`
        SELECT canonical_name, user_label, user_notes FROM entities
        WHERE user_label IS NOT NULL AND user_dismissed = 0
      `).all() as any[];
      const userDismissed = db.prepare(`
        SELECT canonical_name FROM entities WHERE user_dismissed = 1
      `).all() as any[];

      const correctionLines = userLabeled.map((e: any) =>
        `- ${e.canonical_name} IS a ${e.user_label}${e.user_notes ? ' (' + e.user_notes + ')' : ''}`
      ).join('\n');
      const dismissedLines = userDismissed.map((e: any) => e.canonical_name).join(', ');

      const prompt = `You are the AI Chief of Staff for Zach Stock. You have DEEP knowledge of his business and must evaluate each contact with that understanding.

BUSINESS CONTEXT:
Zach Stock is the founder of Recapture Insurance, a Managing General Agency (MGA) in the insurance industry.
- An MGA underwrites policies on behalf of carriers. Carrier capacity is existential.
- Zach has ADHD — he drops balls from context-switching, not lack of caring.
${businessCtx ? '\nAdditional user-provided context:\n' + businessCtx : ''}

USER-VERIFIED CORRECTIONS (THESE ARE ABSOLUTE — NEVER contradict):
${correctionLines || '(none)'}

DISMISSED CONTACTS (NEVER surface these):
${dismissedLines || '(none)'}

IMPORTANT: Do NOT assume which projects a person is connected to. The data below shows exactly which projects each entity appears in. Trust the DATA, not assumptions. If an entity's communications are all about "Physician Cyber Program", they are NOT involved in "Carefront" even if both are insurance projects.

EVALUATION INSTRUCTIONS:
For each entity, analyze their ENTIRE communication history including extracted commitments, decisions, and action items. Consider:
1. What is this person's actual relationship? Use the communication CONTENT, not just frequency.
2. Are there OPEN QUESTIONS or REQUESTS in their emails that genuinely need a response? (Policy deliveries, invoices, and FYI emails do NOT need replies even if tagged "awaiting reply")
3. How does this person connect to Zach's key projects and other important people? (Cross-entity impact)
4. What would a brilliant human Chief of Staff recommend about this relationship RIGHT NOW?
5. Should the system surface alerts about this person, or stay SILENT? (Silence is better than noise)

CRITICAL: An email tagged "awaiting reply" does NOT mean a reply is needed. Evaluate the CONTENT: Does it contain an open question? A request? A time-sensitive ask? Or is it informational/transactional?

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

// ── Task 07: Project Understanding ──────────────────────────
// LLM evaluates each active project with full context: items, people, commitments, timeline

async function task07ProjectUnderstanding(db: Database.Database): Promise<TaskResult> {
  const start = Date.now();
  try {
    const projects = db.prepare(`
      SELECT project, COUNT(*) as item_count, MAX(source_date) as last_activity,
        GROUP_CONCAT(DISTINCT source) as sources
      FROM knowledge_primary
      WHERE project IS NOT NULL AND project != ''
      GROUP BY project HAVING item_count >= 3
      ORDER BY MAX(source_date) DESC LIMIT 15
    `).all() as any[];

    if (projects.length === 0) {
      return { task: '07-project-understanding', status: 'skipped', duration_seconds: 0, output: { reason: 'no active projects' } };
    }

    // Build context for all projects in one prompt
    const projectContexts = projects.map((proj: any) => {
      // Key people
      const people = db.prepare(`
        SELECT e.canonical_name, e.user_label, e.relationship_type, COUNT(*) as cnt
        FROM entity_mentions em
        JOIN knowledge k ON em.knowledge_item_id = k.id
        JOIN entities e ON em.entity_id = e.id
        WHERE k.project = ? AND e.type = 'person' AND e.user_dismissed = 0
          AND e.canonical_name NOT LIKE '%Zach%Stock%'
        GROUP BY e.id ORDER BY cnt DESC LIMIT 5
      `).all(proj.project) as any[];

      // Recent items
      const items = db.prepare(`
        SELECT title, source, source_date, summary FROM knowledge_primary
        WHERE project = ? ORDER BY source_date DESC LIMIT 10
      `).all(proj.project) as any[];

      // Open commitments
      const commitments = db.prepare(`
        SELECT text, state, due_date, owner FROM commitments
        WHERE project = ? AND state IN ('active', 'overdue', 'detected')
      `).all(proj.project) as any[];

      const daysSince = Math.floor((Date.now() - new Date(proj.last_activity).getTime()) / 86400000);

      return `
PROJECT: ${proj.project}
Items: ${proj.item_count} | Last activity: ${daysSince}d ago | Sources: ${proj.sources}
Key people: ${people.map((p: any) => `${p.canonical_name} [${p.user_label || p.relationship_type || '?'}](${p.cnt})`).join(', ') || 'none'}
Open commitments: ${commitments.length}
${commitments.map((c: any) => `  - ${c.text} [${c.state}]${c.due_date ? ' due: ' + c.due_date : ''}`).join('\n') || '  (none)'}
Recent activity:
${items.slice(0, 8).map((i: any) => `  ${i.source_date?.slice(0, 10) || '?'} | ${i.source} | ${i.title}`).join('\n')}
`;
    }).join('\n---\n');

    const prompt = `You are the AI Chief of Staff for Zach Stock, founder of Recapture Insurance (MGA). Analyze each project and provide a strategic assessment.

For each project, determine:
1. Current status and momentum (accelerating, steady, stalling, stalled, dead)
2. What's the single most important next action?
3. Key risks or blockers
4. Who is the most critical person to this project right now?
5. Is anything being neglected that shouldn't be?

PROJECTS:
${projectContexts}

Return ONLY this JSON array:
[{
  "project": "name",
  "status": "accelerating|steady|stalling|stalled|dead",
  "status_reasoning": "one sentence why",
  "next_action": "the single most important thing to do",
  "risks": ["risk 1", "risk 2"],
  "critical_person": "name or null",
  "neglected_items": ["anything being dropped"],
  "importance": "critical|high|medium|low",
  "confidence": 0.0-1.0
}]`;

    const response = await callClaude(prompt, 180000);
    const parsed = tryParseJSON(response);

    if (parsed && Array.isArray(parsed)) {
      // Store project profiles in graph_state
      db.prepare(`
        INSERT OR REPLACE INTO graph_state (key, value, updated_at)
        VALUES ('project_profiles', ?, datetime('now'))
      `).run(JSON.stringify(parsed));

      return {
        task: '07-project-understanding',
        status: 'success',
        duration_seconds: (Date.now() - start) / 1000,
        output: { projects_evaluated: parsed.length, statuses: parsed.map((p: any) => `${p.project}: ${p.status}`).join(', ') },
      };
    }

    return { task: '07-project-understanding', status: 'failed', duration_seconds: (Date.now() - start) / 1000, error: 'Could not parse response' };
  } catch (err: any) {
    return { task: '07-project-understanding', status: 'failed', duration_seconds: (Date.now() - start) / 1000, error: err.message };
  }
}

// ── Task 08: Commitment Verification ────────────────────────
// LLM reads actual email context to verify if commitments are real, fulfilled, or stale

async function task08CommitmentVerification(db: Database.Database): Promise<TaskResult> {
  const start = Date.now();
  try {
    const commitments = db.prepare(`
      SELECT c.id, c.text, c.state, c.due_date, c.owner, c.assigned_to, c.project,
        c.detected_from
      FROM commitments c
      WHERE c.state IN ('active', 'overdue', 'detected')
      ORDER BY c.due_date ASC LIMIT 30
    `).all() as any[];

    if (commitments.length === 0) {
      return { task: '08-commitment-verify', status: 'skipped', duration_seconds: 0, output: { reason: 'no active commitments' } };
    }

    // For each commitment, get the source context + any recent activity
    const commitmentContexts = commitments.map((c: any) => {
      let sourceContext = '';
      if (c.detected_from) {
        const item = db.prepare('SELECT title, summary, source, source_date FROM knowledge WHERE id = ?').get(c.detected_from) as any;
        if (item) sourceContext = `Source: ${item.source_date?.slice(0, 10)} | ${item.source} | ${item.title}\n  ${item.summary?.slice(0, 200)}`;
      }

      // Check for resolution evidence — newer items mentioning same people/project
      let recentActivity = '';
      if (c.project) {
        const recent = db.prepare(`
          SELECT title, source_date FROM knowledge_primary
          WHERE project = ? AND source_date > ? ORDER BY source_date DESC LIMIT 3
        `).all(c.project, c.due_date || '2000-01-01') as any[];
        if (recent.length > 0) {
          recentActivity = 'Recent project activity:\n' + recent.map((r: any) => `  ${r.source_date?.slice(0, 10)} | ${r.title}`).join('\n');
        }
      }

      return `COMMITMENT: "${c.text}"
State: ${c.state} | Due: ${c.due_date || 'none'} | Owner: ${c.owner || '?'} | Assigned: ${c.assigned_to || '?'} | Project: ${c.project || '?'}
${sourceContext}
${recentActivity}`;
    }).join('\n---\n');

    const prompt = `Review these business commitments for Zach Stock (Recapture Insurance MGA). For each, determine if it's still valid, has been fulfilled, or should be dropped.

COMMITMENTS:
${commitmentContexts}

For each commitment, assess:
1. Is this still a real, active obligation?
2. Has it likely been fulfilled (based on recent activity)?
3. Is it stale (so old that following up would be weird)?
4. What should Zach do about it?

Return ONLY this JSON array:
[{
  "text": "commitment text (exact match)",
  "current_state": "active|fulfilled|stale|invalid",
  "reasoning": "why this assessment",
  "recommended_action": "what to do or null",
  "confidence": 0.0-1.0
}]`;

    const response = await callClaude(prompt, 180000);
    const parsed = tryParseJSON(response);

    if (parsed && Array.isArray(parsed)) {
      let updated = 0;
      for (const item of parsed) {
        if (!item.text || !item.current_state) continue;

        // Map to commitment states
        const stateMap: Record<string, string> = {
          'fulfilled': 'done', 'stale': 'abandoned', 'invalid': 'abandoned', 'active': 'active'
        };
        const newState = stateMap[item.current_state] || item.current_state;

        if (newState !== 'active') {
          // Find and update the commitment
          const match = db.prepare(
            "SELECT id FROM commitments WHERE text = ? AND state IN ('active', 'overdue', 'detected')"
          ).get(item.text) as any;
          if (match) {
            db.prepare("UPDATE commitments SET state = ?, state_changed_at = datetime('now') WHERE id = ?")
              .run(newState, match.id);
            updated++;
          }
        }
      }

      // Store full verification results
      db.prepare(`
        INSERT OR REPLACE INTO graph_state (key, value, updated_at)
        VALUES ('commitment_verification', ?, datetime('now'))
      `).run(JSON.stringify(parsed));

      return {
        task: '08-commitment-verify',
        status: 'success',
        duration_seconds: (Date.now() - start) / 1000,
        output: { verified: parsed.length, state_changes: updated },
      };
    }

    return { task: '08-commitment-verify', status: 'failed', duration_seconds: (Date.now() - start) / 1000, error: 'Could not parse response' };
  } catch (err: any) {
    return { task: '08-commitment-verify', status: 'failed', duration_seconds: (Date.now() - start) / 1000, error: err.message };
  }
}

// ── Task 09: World Narrative Synthesis ───────────────────────
// LLM takes ALL the intelligence (entity profiles, project profiles, commitment
// verdicts, alerts) and produces a narrative that tells the STORY of the business.
// This replaces the SQL-generated world model with something that actually understands.

async function task09WorldNarrative(db: Database.Database): Promise<TaskResult> {
  const start = Date.now();
  try {
    // Gather all intelligence products
    const entityProfiles = db.prepare(`
      SELECT ep.*, e.canonical_name, e.email, e.domain
      FROM entity_profiles ep
      JOIN entities e ON ep.entity_id = e.id
      WHERE ep.alert_verdict = 'surface'
      ORDER BY ep.verdict_confidence DESC
    `).all() as any[];

    const projectProfiles = (db.prepare(
      "SELECT value FROM graph_state WHERE key = 'project_profiles'"
    ).get() as any)?.value;
    const projects = projectProfiles ? JSON.parse(projectProfiles) : [];

    const commitmentResults = (db.prepare(
      "SELECT value FROM graph_state WHERE key = 'commitment_verification'"
    ).get() as any)?.value;
    const commitments = commitmentResults ? JSON.parse(commitmentResults) : [];

    // Get today's calendar if available
    const today = new Date().toISOString().slice(0, 10);
    const calendarItems = db.prepare(`
      SELECT title, summary, source_date FROM knowledge_primary
      WHERE source = 'calendar' AND source_date >= ? AND source_date < datetime(?, '+1 day')
      ORDER BY source_date ASC
    `).all(today, today) as any[];

    const surfaceAlerts = entityProfiles.map((ep: any) =>
      `${ep.canonical_name} [${ep.communication_nature}]: ${ep.verdict_reasoning} (${Math.round(ep.verdict_confidence * 100)}% confidence)`
    ).join('\n');

    const projectSummary = projects.map((p: any) =>
      `${p.project} [${p.status}]: ${p.status_reasoning}${p.next_action ? ' Next: ' + p.next_action : ''}`
    ).join('\n');

    const activeCommitments = commitments
      .filter((c: any) => c.current_state === 'active')
      .map((c: any) => `- ${c.text}: ${c.reasoning}${c.recommended_action ? ' → ' + c.recommended_action : ''}`)
      .join('\n');

    const calendarSummary = calendarItems.map((c: any) =>
      `${c.source_date?.slice(11, 16) || '?'} ${c.title}`
    ).join('\n');

    // Load user corrections as hard constraints for the narrative
    const userCorrections = db.prepare(`
      SELECT canonical_name, user_label, user_notes FROM entities
      WHERE user_label IS NOT NULL AND user_dismissed = 0
    `).all() as any[];
    const correctionBlock = userCorrections.map((e: any) =>
      `- ${e.canonical_name} = ${e.user_label}${e.user_notes ? ' (' + e.user_notes + ')' : ''}`
    ).join('\n');

    // Load the SQL world model as verified facts
    const worldModelPath = join(homedir(), '.prime', 'world.md');
    let verifiedFacts = '';
    try { verifiedFacts = readFileSync(worldModelPath, 'utf-8'); } catch {}

    const prompt = `You are the AI Chief of Staff synthesizing a daily intelligence briefing for Zach Stock, founder of Recapture Insurance (MGA/insurtech).

Write a concise narrative (not a data dump) that tells Zach what he needs to know TODAY. Write as if you are his most trusted advisor speaking directly to him. Be opinionated — prioritize, recommend, warn.

VERIFIED FACTS (from SQL world model — primary sources only, treat as TRUE):
${verifiedFacts.slice(0, 4000) || '(no world model available)'}

USER-VERIFIED CORRECTIONS (ABSOLUTE — NEVER contradict these):
${correctionBlock || '(none)'}

ENTITY INTELLIGENCE (from dream analysis — useful but flag uncertainty):
${surfaceAlerts || '(none — all relationships healthy)'}

PROJECT INTELLIGENCE (from dream analysis):
${projectSummary || '(no project intelligence yet)'}

ACTIVE COMMITMENTS:
${activeCommitments || '(none verified active)'}

TODAY'S CALENDAR:
${calendarSummary || '(no calendar events)'}

FORMAT:
1. **The One Thing** — the single most important item today (if nothing urgent, say so)
2. **People** — who needs attention and why (max 5, with specific recommended actions)
3. **Projects** — 1-sentence status on each active project, flag anything stalling
4. **Commitments** — only ones that are genuinely pending and matter
5. **Today** — calendar context if relevant
6. **This Week** — what to be thinking about for the rest of the week

RULES:
- Build your narrative from VERIFIED FACTS as the skeleton
- Add reasoning from entity/project intelligence but flag uncertainty
- Before associating any person with a project, VERIFY the association exists in VERIFIED FACTS
- NEVER contradict USER-VERIFIED CORRECTIONS
- If something is fine, don't mention it (selective silence)
- If you're uncertain, say so — "(inferred)" vs "(verified)"
- Write for someone with ADHD who will skim this in 60 seconds

Return the briefing as plain text (markdown OK). No JSON wrapper.`;

    const narrative = await callClaude(prompt, 180000);

    if (narrative && narrative.length > 100) {
      // Save as world narrative
      const narrativePath = join(homedir(), '.prime', 'world-narrative.md');
      writeFileSync(narrativePath, `# Daily Intelligence Briefing\n_Generated: ${new Date().toLocaleString()}_\n\n${narrative}`);

      // Also store in graph_state for programmatic access
      db.prepare(`
        INSERT OR REPLACE INTO graph_state (key, value, updated_at)
        VALUES ('world_narrative', ?, datetime('now'))
      `).run(narrative);

      return {
        task: '09-world-narrative',
        status: 'success',
        duration_seconds: (Date.now() - start) / 1000,
        output: { length: narrative.length, saved_to: narrativePath },
      };
    }

    return { task: '09-world-narrative', status: 'failed', duration_seconds: (Date.now() - start) / 1000, error: 'Empty narrative' };
  } catch (err: any) {
    return { task: '09-world-narrative', status: 'failed', duration_seconds: (Date.now() - start) / 1000, error: err.message };
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

  // Task 02: SKIPPED — replaced by Task 06 (deep entity understanding)
  // Task 02 was shallow (stats only). Task 06 sends full context + extracted intelligence.

  // Task 03: Commitment check
  console.log('  Task 03: Check commitments...');
  const r03 = await task03CommitmentCheck(db);
  results.push(r03);
  console.log(`    ${r03.status === 'success' ? '✓' : '✗'} ${r03.status} (${r03.duration_seconds.toFixed(1)}s)${r03.output ? ` — ${JSON.stringify(r03.output).slice(0, 100)}` : ''}`);

  // ── INTELLIGENCE LAYER (LLM-powered, skip in quick mode) ──────
  if (!options.quick) {
    // Task 06: Entity Understanding — WHO matters and WHY
    console.log('  Task 06: Entity understanding (LLM)...');
    const r06 = await task06EntityUnderstanding(db);
    results.push(r06);
    console.log(`    ${r06.status === 'success' ? '✓' : r06.status === 'skipped' ? '○' : '✗'} ${r06.status} (${r06.duration_seconds.toFixed(1)}s)${r06.output ? ` — ${JSON.stringify(r06.output).slice(0, 100)}` : ''}`);

    // Task 07: Project Understanding — WHAT's happening and WHERE it's going
    console.log('  Task 07: Project understanding (LLM)...');
    const r07 = await task07ProjectUnderstanding(db);
    results.push(r07);
    console.log(`    ${r07.status === 'success' ? '✓' : r07.status === 'skipped' ? '○' : '✗'} ${r07.status} (${r07.duration_seconds.toFixed(1)}s)${r07.output ? ` — ${JSON.stringify(r07.output).slice(0, 150)}` : ''}`);

    // Task 08: Commitment Verification — WHAT's real vs stale
    console.log('  Task 08: Commitment verification (LLM)...');
    const r08 = await task08CommitmentVerification(db);
    results.push(r08);
    console.log(`    ${r08.status === 'success' ? '✓' : r08.status === 'skipped' ? '○' : '✗'} ${r08.status} (${r08.duration_seconds.toFixed(1)}s)${r08.output ? ` — ${JSON.stringify(r08.output).slice(0, 100)}` : ''}`);
  }

  // Task 04: Structured world rebuild (SQL data model, used by programmatic consumers)
  console.log('  Task 04: Rebuild structured world model...');
  const r04 = await task04WorldRebuild(db);
  results.push(r04);
  console.log(`    ${r04.status === 'success' ? '✓' : '✗'} ${r04.status} (${r04.duration_seconds.toFixed(1)}s)${r04.output ? ` — ${JSON.stringify(r04.output).slice(0, 100)}` : ''}`);

  // ── SYNTHESIS LAYER (LLM-powered, skip in quick mode) ──────
  if (!options.quick) {
    // Task 09: World Narrative — the STORY, not the data
    console.log('  Task 09: Synthesize world narrative (LLM)...');
    const r09 = await task09WorldNarrative(db);
    results.push(r09);
    console.log(`    ${r09.status === 'success' ? '✓' : '✗'} ${r09.status} (${r09.duration_seconds.toFixed(1)}s)${r09.output ? ` — ${JSON.stringify(r09.output).slice(0, 100)}` : ''}`);

    // Task 05: Self-audit — grade OUR OWN work
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
