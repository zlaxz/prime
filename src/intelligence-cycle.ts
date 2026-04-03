import type Database from 'better-sqlite3';
import { getConfig, searchByFTS } from './db.js';
import { callClaude } from './dream.js';
import { syncAll } from './connectors/index.js';

// ============================================================
// Intelligence Cycle — Strategic Reasoning Engine
//
// Architecture: SQL context assembly + ONE deep Claude call
//
// 1. SQL: Assemble ALL pipeline outputs into a single context document
// 2. SQL: Detect anomalies, contradictions, weak signals (free, fast)
// 3. Claude (Opus via callClaude): Reason about everything holistically
// 4. SQL: Parse and store structured output
//
// This uses Claude (via Max subscription, $0) not gpt-4.1-nano.
// The entire intelligence layer is one deep reasoning call.
// ============================================================

interface TaskResult {
  task: string;
  status: 'success' | 'failed' | 'skipped';
  duration_seconds: number;
  output?: any;
  error?: string;
}

// ── Phase 1: SQL Context Assembly ────────────────────────────
// Gathers ALL outputs from the dream pipeline's perception tasks
// into one structured context document for Claude to reason about.

function assembleContext(db: Database.Database): string {
  const sections: string[] = [];

  // 1. Project profiles (from Task 07)
  const profilesRaw = (db.prepare("SELECT value FROM graph_state WHERE key = 'project_profiles'").get() as any)?.value;
  if (profilesRaw) {
    const profiles = JSON.parse(profilesRaw);
    sections.push('## ACTIVE PROJECTS\n');
    for (const p of profiles) {
      if (p.status === 'archived' || p.status === 'completed') continue;
      sections.push(`### ${p.project}`);
      sections.push(`Status: ${p.status} | ${p.status_reasoning || ''}`);
      sections.push(`Next action: ${p.next_action || 'none identified'}`);
      sections.push('');
    }
  }

  // 2. Entity profiles (from Task 06)
  const topEntities = db.prepare(`
    SELECT e.canonical_name, e.user_label, e.relationship_type,
      ep.communication_nature, ep.reply_expectation,
      COUNT(DISTINCT k.id) as recent_mentions,
      MAX(k.source_date) as last_seen,
      GROUP_CONCAT(DISTINCT k.project) as projects
    FROM entities e
    LEFT JOIN entity_profiles ep ON e.id = ep.entity_id
    JOIN entity_mentions em ON e.id = em.entity_id
    JOIN knowledge k ON em.knowledge_item_id = k.id
    WHERE e.user_dismissed = 0
      AND e.canonical_name NOT LIKE '%Zach%Stock%'
      AND k.source_date >= datetime('now', '-30 days')
      AND e.user_label IS NOT NULL
      AND e.user_label NOT IN ('dismissed', 'noise', 'solicitation')
    GROUP BY e.id
    ORDER BY recent_mentions DESC
    LIMIT 20
  `).all() as any[];

  if (topEntities.length > 0) {
    sections.push('## KEY PEOPLE\n');
    for (const e of topEntities) {
      sections.push(`- **${e.canonical_name}** (${e.user_label || e.relationship_type || 'unknown'}) — ${e.recent_mentions} mentions, last seen ${e.last_seen?.slice(0, 10) || 'unknown'}, projects: ${e.projects || 'none'}`);
      if (e.communication_nature) sections.push(`  Communication: ${e.communication_nature}, reply expectation: ${e.reply_expectation || 'unknown'}`);
    }
    sections.push('');
  }

  // 3. Active commitments
  const commitments = db.prepare(`
    SELECT text, owner, project, due_date, state, assigned_to
    FROM commitments
    WHERE state NOT IN ('fulfilled', 'cancelled', 'archived')
    ORDER BY
      CASE WHEN due_date IS NOT NULL THEN 0 ELSE 1 END,
      due_date ASC
    LIMIT 30
  `).all() as any[];

  if (commitments.length > 0) {
    sections.push('## OPEN COMMITMENTS\n');
    for (const c of commitments) {
      const due = c.due_date ? ` (due: ${c.due_date.slice(0, 10)})` : '';
      sections.push(`- [${c.state}] ${c.owner}: ${c.text}${due} — project: ${c.project || 'unassigned'}`);
    }
    sections.push('');
  }

  // 4. World narrative (from Task 09)
  const narrativeRaw = (db.prepare("SELECT value FROM graph_state WHERE key = 'world_narrative'").get() as any)?.value;
  if (narrativeRaw) {
    sections.push('## WORLD NARRATIVE\n');
    sections.push(narrativeRaw.slice(0, 3000));
    sections.push('');
  }

  // 5. Cross-project patterns (from Task 23)
  const patternsRaw = (db.prepare("SELECT value FROM graph_state WHERE key = 'cross_project_patterns'").get() as any)?.value;
  if (patternsRaw) {
    const patterns = JSON.parse(patternsRaw);
    if (patterns.length > 0) {
      sections.push('## CROSS-PROJECT PATTERNS\n');
      for (const p of patterns) {
        sections.push(`- [${p.type}] ${p.insight}`);
      }
      sections.push('');
    }
  }

  // 6. Narrative threads (from Task 17)
  const threads = db.prepare(`
    SELECT title, summary, status, item_count, updated_at
    FROM narrative_threads
    WHERE status = 'active' AND updated_at >= datetime('now', '-14 days')
    ORDER BY updated_at DESC LIMIT 15
  `).all() as any[];

  if (threads.length > 0) {
    sections.push('## ACTIVE NARRATIVE THREADS\n');
    for (const t of threads) {
      sections.push(`- **${t.title}** (${t.item_count} items, updated ${t.updated_at?.slice(0, 10)}): ${t.summary?.slice(0, 150) || ''}`);
    }
    sections.push('');
  }

  // 7. Recent staged actions (from Task 18)
  const actions = db.prepare(`
    SELECT summary, reasoning, type, source_task, status
    FROM staged_actions
    WHERE created_at >= datetime('now', '-3 days')
    ORDER BY created_at DESC LIMIT 10
  `).all() as any[];

  if (actions.length > 0) {
    sections.push('## RECENT STAGED ACTIONS\n');
    for (const a of actions) {
      sections.push(`- [${a.type}/${a.status}] ${a.summary}: ${a.reasoning?.slice(0, 100) || ''}`);
    }
    sections.push('');
  }

  // 8. Investigation results (from Task 14, stored in graph_state)
  const investigationRaw = (db.prepare("SELECT value FROM graph_state WHERE key = 'investigation_results'").get() as any)?.value;
  if (investigationRaw) {
    sections.push('## STRATEGIC INVESTIGATION RESULTS\n');
    sections.push(investigationRaw.slice(0, 3000));
    sections.push('');
  }

  // 9. TODAY's items — raw, unprocessed, ALL of them (not just high-importance)
  // This is critical: pipeline perception tasks may not have run yet, but the
  // intelligence cycle must see today's emails/messages regardless of classification
  const todayItems = db.prepare(`
    SELECT title, summary, source, source_date, project, raw_content
    FROM knowledge
    WHERE source_date >= datetime('now', '-24 hours')
      AND source NOT IN ('agent-notification', 'agent-report', 'briefing', 'directive')
    ORDER BY source_date DESC LIMIT 30
  `).all() as any[];

  if (todayItems.length > 0) {
    sections.push('## TODAY\'S ITEMS (LAST 24 HOURS — FRESHEST DATA, MAY NOT BE IN PIPELINE YET)\n');
    for (const item of todayItems) {
      const content = item.raw_content
        ? item.raw_content.slice(0, 500)
        : item.summary?.slice(0, 200) || '';
      sections.push(`- [${item.source} ${item.source_date?.slice(0, 16)}] ${item.title}`);
      sections.push(`  ${content}`);
    }
    sections.push('');
  }

  // 10. Recent high-importance items (last 7 days, excluding today which is above)
  const recentItems = db.prepare(`
    SELECT title, summary, source, source_date, project
    FROM knowledge_primary
    WHERE source_date >= datetime('now', '-7 days')
      AND source_date < datetime('now', '-24 hours')
      AND importance IN ('critical', 'high')
    ORDER BY source_date DESC LIMIT 20
  `).all() as any[];

  if (recentItems.length > 0) {
    sections.push('## HIGH-IMPORTANCE ITEMS (PAST 7 DAYS)\n');
    for (const item of recentItems) {
      sections.push(`- [${item.source} ${item.source_date?.slice(0, 10)}] ${item.title}: ${item.summary?.slice(0, 150) || ''}`);
    }
    sections.push('');
  }

  return sections.join('\n');
}

// ── Phase 2: SQL Anomaly Detection ──────────────────────────
// Pure SQL — finds weak signals, contradictions, anomalies

function detectAnomalies(db: Database.Database): string {
  const sections: string[] = [];

  // Communication anomalies — entities whose frequency changed significantly
  const anomalies = db.prepare(`
    WITH recent AS (
      SELECT e.canonical_name,
        COUNT(CASE WHEN k.source_date >= datetime('now', '-7 days') THEN 1 END) as last_week,
        COUNT(CASE WHEN k.source_date >= datetime('now', '-30 days') AND k.source_date < datetime('now', '-7 days') THEN 1 END) as prev_3weeks
      FROM entity_mentions em
      JOIN entities e ON em.entity_id = e.id
      JOIN knowledge k ON em.knowledge_item_id = k.id
      WHERE e.user_dismissed = 0
        AND e.canonical_name NOT LIKE '%Zach%Stock%'
        AND k.source_date >= datetime('now', '-30 days')
      GROUP BY e.id
      HAVING prev_3weeks >= 3
    )
    SELECT canonical_name, last_week, prev_3weeks
    FROM recent
    WHERE last_week = 0 OR CAST(last_week AS FLOAT) / (prev_3weeks / 3.0) >= 3.0
    ORDER BY ABS(CAST(last_week AS FLOAT) / NULLIF(prev_3weeks / 3.0, 0) - 1.0) DESC
    LIMIT 10
  `).all() as any[];

  if (anomalies.length > 0) {
    sections.push('## COMMUNICATION ANOMALIES\n');
    for (const a of anomalies) {
      const pattern = a.last_week === 0 ? 'WENT SILENT' : `surged ${(a.last_week / (a.prev_3weeks / 3.0)).toFixed(1)}x`;
      sections.push(`- ${a.canonical_name}: ${pattern} (${a.last_week} mentions last week vs ${a.prev_3weeks} in prior 3 weeks)`);
    }
    sections.push('');
  }

  // Commitment contradictions — active commitments from silent entities
  const contradictions = db.prepare(`
    SELECT c.text, c.owner, c.project, c.state, c.due_date,
      MAX(k.source_date) as last_comm
    FROM commitments c
    JOIN entities e ON c.owner LIKE '%' || e.canonical_name || '%'
    JOIN entity_mentions em ON e.id = em.entity_id
    JOIN knowledge k ON em.knowledge_item_id = k.id
    WHERE c.state IN ('active', 'overdue')
      AND e.user_dismissed = 0
    GROUP BY c.id
    HAVING julianday('now') - julianday(MAX(k.source_date)) > 7
    ORDER BY last_comm ASC
    LIMIT 10
  `).all() as any[];

  if (contradictions.length > 0) {
    sections.push('## CONTRADICTIONS: ACTIVE COMMITMENTS FROM SILENT ENTITIES\n');
    for (const c of contradictions) {
      const daysSilent = Math.round((Date.now() - new Date(c.last_comm).getTime()) / 86400000);
      sections.push(`- ${c.owner}: "${c.text}" (${c.state}) — but last communication was ${daysSilent} days ago`);
    }
    sections.push('');
  }

  // Stale project status — marked active but no recent items
  const profilesRaw = (db.prepare("SELECT value FROM graph_state WHERE key = 'project_profiles'").get() as any)?.value;
  if (profilesRaw) {
    const stale: string[] = [];
    for (const p of JSON.parse(profilesRaw)) {
      if (p.status === 'accelerating' || p.status === 'active') {
        const recentCount = (db.prepare(
          "SELECT COUNT(*) as c FROM knowledge WHERE project = ? AND source_date >= datetime('now', '-7 days')"
        ).get(p.project) as any)?.c || 0;
        if (recentCount === 0) {
          stale.push(`- ${p.project}: marked "${p.status}" but 0 items in last 7 days`);
        }
      }
    }
    if (stale.length > 0) {
      sections.push('## STALE STATUS: ACTIVE PROJECTS WITH NO RECENT ACTIVITY\n');
      sections.push(...stale);
      sections.push('');
    }
  }

  // Unthreaded strategic items — potential weak signals
  const unthreaded = db.prepare(`
    SELECT title, summary, source, source_date FROM knowledge_primary
    WHERE source_date >= datetime('now', '-7 days')
      AND id NOT IN (SELECT knowledge_item_id FROM thread_items)
      AND source NOT IN ('calendar', 'agent-notification', 'agent-report', 'briefing', 'directive')
      AND (summary LIKE '%acqui%' OR summary LIKE '%restructur%' OR summary LIKE '%regulat%'
        OR summary LIKE '%confidential%' OR summary LIKE '%opportunity%' OR summary LIKE '%compet%'
        OR summary LIKE '%leaving%' OR summary LIKE '%joining%' OR summary LIKE '%pivot%')
    ORDER BY source_date DESC LIMIT 10
  `).all() as any[];

  if (unthreaded.length > 0) {
    sections.push('## POTENTIAL WEAK SIGNALS (unthreaded items with strategic keywords)\n');
    for (const item of unthreaded) {
      sections.push(`- [${item.source} ${item.source_date?.slice(0, 10)}] ${item.title}: ${item.summary?.slice(0, 150)}`);
    }
    sections.push('');
  }

  return sections.join('\n');
}

// ── Phase 3: One Deep Claude Call ────────────────────────────

const INTELLIGENCE_PROMPT = `You are a strategic intelligence analyst with COMPLETE visibility into all of Zach Stock's business operations. You have been given every signal the system has collected — project status, entity profiles, commitments, narrative threads, cross-project patterns, investigation results, communication anomalies, and contradictions.

Your job is not to summarize. Your job is to REASON. Find what the data implies that it doesn't state. Generate knowledge that doesn't exist in any individual item.

Analyze everything and produce a strategic intelligence brief. Return ONLY valid JSON:

{
  "headline": "One sentence — the single most important thing Zach needs to know RIGHT NOW",
  "the_one_thing": "The ONE specific action with the highest leverage this week. Not vague. Specific person, specific ask, specific deadline.",
  "hypotheses": [
    {
      "claim": "Clear statement of what you believe is happening",
      "type": "connection|opportunity|threat|prediction|theory_of_mind",
      "confidence": 65,
      "projects_involved": ["project names"],
      "evidence_for": ["specific evidence from the data above"],
      "evidence_against": ["what contradicts this or suggests alternatives"],
      "key_assumption": "The ONE thing that if wrong, kills this hypothesis",
      "time_sensitivity": "urgent|this_week|this_month|none",
      "action": "What to do about it",
      "verification": "How to test if this is true"
    }
  ],
  "theories_of_mind": [
    {
      "entity": "Person name",
      "knows": ["what they likely know about Zach's position"],
      "wants": ["their motivations"],
      "constraints": ["what limits them"],
      "behavior_hypothesis": "Why they're acting the way they are",
      "likely_next_move": "What they'll probably do next"
    }
  ],
  "implication_chains": [
    {
      "hypothesis": "Which hypothesis this traces",
      "first_order": "Immediate consequence",
      "second_order": "What that leads to",
      "third_order": "Strategic endgame",
      "risk": "What could break the chain",
      "critical_action": "The one thing to do if true"
    }
  ],
  "contradictions": [
    {
      "tension": "What conflicts with what",
      "resolution": "What should be done to resolve it"
    }
  ],
  "weak_signals": [
    {
      "signal": "What was detected",
      "why_it_matters": "Strategic significance"
    }
  ],
  "actions": [
    {
      "priority": 1,
      "title": "Short action title",
      "type": "call|email|prepare|decide|investigate|wait",
      "target_person": "Name or null",
      "deadline": "today|tomorrow|this_week|this_month",
      "rationale": "Why this action, why this priority, what it unlocks",
      "draft": "If type is email: full draft text in Zach's voice (direct, confident, no corporate-speak). If type is call: talking points. If type is prepare: outline of what to prepare. Otherwise null.",
      "depends_on": "What must be true or done first, or null"
    }
  ]
}

Requirements:
- Generate 5-8 hypotheses. At least 2 must connect DIFFERENT projects. At least 1 must be theory-of-mind (why someone is acting a certain way). At least 1 must be speculative/non-obvious.
- Rate confidence honestly: 30=speculation, 50=plausible, 70=likely, 90=near-certain. Do NOT default everything to 50.
- For the top 3-5 entities in the data, provide a theory of mind.
- For the top 2 hypotheses, trace implication chains (1st→2nd→3rd order).
- Flag any contradictions you find between claims, commitments, and behavior.
- Identify weak signals that don't fit any pattern but could be strategically important.
- "The one thing" must be actionable THIS WEEK with a specific person and specific ask.
- Generate 3-5 ACTIONS ranked by priority. Each must be concrete — specific person, specific deliverable, specific deadline. For emails, WRITE THE FULL DRAFT in Zach's voice. For calls, provide talking points. For preparation, provide the outline. The goal is ZERO activation energy — Zach should be able to execute each action with ONE tap.`;

// ── Main Entry Point ────────────────────────────────────────

export async function runIntelligenceCycle(db: Database.Database): Promise<TaskResult> {
  const start = Date.now();

  try {
    // Phase 0: Force data refresh — intelligence must reason on FRESH data
    console.log('    Phase 0: Syncing all data sources (Gmail, Calendar, Claude, Cowork)...');
    try {
      const syncResults = await syncAll(db);
      const totalSynced = syncResults.reduce((s, r) => s + r.items, 0);
      console.log(`      Synced ${totalSynced} items from ${syncResults.filter(r => r.items > 0).length} sources`);
    } catch (syncErr: any) {
      console.log(`      Sync warning: ${syncErr.message?.slice(0, 100)} (continuing with existing data)`);
    }

    // Phase 1: Assemble all pipeline outputs into context
    console.log('    Phase 1: Assembling context from all pipeline outputs...');
    const pipelineContext = assembleContext(db);
    console.log(`      ${pipelineContext.length} chars of pipeline context`);

    // Phase 2: Detect anomalies (pure SQL)
    console.log('    Phase 2: Anomaly detection (SQL)...');
    const anomalyContext = detectAnomalies(db);
    console.log(`      ${anomalyContext.length} chars of anomaly context`);

    const totalContext = pipelineContext + '\n' + anomalyContext;

    if (totalContext.length < 500) {
      return {
        task: '24-intelligence-cycle',
        status: 'skipped',
        duration_seconds: (Date.now() - start) / 1000,
        output: { message: 'Insufficient context for intelligence cycle' },
      };
    }

    // Phase 3: One deep Claude call — Opus quality, $0 on Max
    // Uses persistent session: accumulates context across dream cycles instead of starting blank
    const sessionKey = 'intelligence_session_id';
    const existingSession = (db.prepare("SELECT value FROM graph_state WHERE key = ?").get(sessionKey) as any)?.value;
    const sessionId = existingSession ? JSON.parse(existingSession) : undefined;

    const sessionNote = sessionId
      ? `\n\nNOTE: You are RESUMING a persistent intelligence session. You have prior context from previous dream cycles. Compare today's data with what you knew before. Were your previous hypotheses confirmed or refuted? What changed?`
      : '';

    console.log(`    Phase 3: Deep reasoning (Claude, ${totalContext.length} chars context${sessionId ? ', RESUMING session ' + sessionId.slice(0, 8) : ', NEW session'})...`);
    const fullPrompt = `${INTELLIGENCE_PROMPT}${sessionNote}\n\n---\n\nHere is everything the system knows as of ${new Date().toISOString().slice(0, 16)}:\n\n${totalContext}`;

    const response = await callClaude(fullPrompt, 600000, sessionId); // 10 min timeout, persistent session

    // Capture session ID for persistent sessions
    if (!sessionId) {
      const newSessionId = (db.prepare("SELECT value FROM graph_state WHERE key = 'last_claude_session_id'").get() as any)?.value;
      if (newSessionId) {
        db.prepare("INSERT OR REPLACE INTO graph_state (key, value, updated_at) VALUES (?, ?, datetime('now'))")
          .run(sessionKey, newSessionId);
        console.log(`      Persistent session established: ${JSON.parse(newSessionId).slice(0, 8)}...`);
      }
    }

    // Phase 4: Parse and store
    console.log('    Phase 4: Parsing and storing results...');

    // Find JSON in response (Claude may wrap it in markdown)
    let jsonStr = response;
    const jsonMatch = response.match(/\{[\s\S]*\}/);
    if (jsonMatch) jsonStr = jsonMatch[0];

    const brief = JSON.parse(jsonStr);

    // Store everything
    db.prepare(
      "INSERT OR REPLACE INTO graph_state (key, value, updated_at) VALUES ('intelligence_brief', ?, datetime('now'))"
    ).run(JSON.stringify(brief));

    db.prepare(
      "INSERT OR REPLACE INTO graph_state (key, value, updated_at) VALUES ('active_hypotheses', ?, datetime('now'))"
    ).run(JSON.stringify(brief.hypotheses || []));

    db.prepare(
      "INSERT OR REPLACE INTO graph_state (key, value, updated_at) VALUES ('theories_of_mind', ?, datetime('now'))"
    ).run(JSON.stringify(brief.theories_of_mind || []));

    db.prepare(
      "INSERT OR REPLACE INTO graph_state (key, value, updated_at) VALUES ('implication_chains', ?, datetime('now'))"
    ).run(JSON.stringify(brief.implication_chains || []));

    db.prepare(
      "INSERT OR REPLACE INTO graph_state (key, value, updated_at) VALUES ('weak_signals', ?, datetime('now'))"
    ).run(JSON.stringify(brief.weak_signals || []));

    db.prepare(
      "INSERT OR REPLACE INTO graph_state (key, value, updated_at) VALUES ('detected_contradictions', ?, datetime('now'))"
    ).run(JSON.stringify(brief.contradictions || []));

    db.prepare(
      "INSERT OR REPLACE INTO graph_state (key, value, updated_at) VALUES ('intelligence_actions', ?, datetime('now'))"
    ).run(JSON.stringify(brief.actions || []));

    // Track hypotheses for meta-learning
    const historyRaw = (db.prepare("SELECT value FROM graph_state WHERE key = 'hypothesis_history'").get() as any)?.value;
    const history = historyRaw ? JSON.parse(historyRaw) : [];
    for (const h of (brief.hypotheses || [])) {
      history.push({
        ...h,
        generated_at: new Date().toISOString(),
        verified: null,
      });
    }
    db.prepare(
      "INSERT OR REPLACE INTO graph_state (key, value, updated_at) VALUES ('hypothesis_history', ?, datetime('now'))"
    ).run(JSON.stringify(history.slice(-100)));

    const hypCount = brief.hypotheses?.length || 0;
    const tomCount = brief.theories_of_mind?.length || 0;

    return {
      task: '24-intelligence-cycle',
      status: 'success',
      duration_seconds: (Date.now() - start) / 1000,
      output: {
        context_chars: totalContext.length,
        hypotheses: hypCount,
        theories_of_mind: tomCount,
        implication_chains: brief.implication_chains?.length || 0,
        contradictions: brief.contradictions?.length || 0,
        weak_signals: brief.weak_signals?.length || 0,
        headline: brief.headline,
        the_one_thing: brief.the_one_thing,
        top_hypothesis: brief.hypotheses?.[0] ? `${brief.hypotheses[0].claim} (${brief.hypotheses[0].confidence}%)` : 'none',
      },
    };
  } catch (err: any) {
    return {
      task: '24-intelligence-cycle',
      status: 'failed',
      duration_seconds: (Date.now() - start) / 1000,
      error: err.message,
    };
  }
}
