import type Database from 'better-sqlite3';
import { callClaude, PERSISTENT_SESSIONS } from './dream.js';

// ============================================================
// Ripple Engine — Cascading Impact Analysis
//
// When a significant event occurs, traces ALL implications
// across ALL projects and generates cascading actions.
//
// Architecture: SQL context assembly + ONE callClaude call
// Same pattern as intelligence-cycle.ts
// ============================================================

interface RippleResult {
  event: string;
  ripples: Array<{
    project: string;
    impact: string;
    new_status: 'on_track' | 'at_risk' | 'accelerated' | 'blocked';
    immediate_action: string;
    downstream: string;
  }>;
  cascading_actions: Array<{
    priority: number;
    title: string;
    type: 'email' | 'call' | 'prepare' | 'update';
    target: string | null;
    rationale: string;
  }>;
}

function assembleRippleContext(db: Database.Database): { projects: string; commitments: string; entities: string } {
  // 1. All project profiles
  let projects = 'No project profiles found.';
  const profilesRaw = (db.prepare("SELECT value FROM graph_state WHERE key = 'project_profiles'").get() as any)?.value;
  if (profilesRaw) {
    const parsed = JSON.parse(profilesRaw);
    const active = parsed.filter((p: any) => p.status !== 'archived' && p.status !== 'completed');
    if (active.length > 0) {
      projects = active.map((p: any) =>
        `- ${p.project} [${p.status}]: ${p.status_reasoning || 'no reasoning'}\n  Next action: ${p.next_action || 'none'}`
      ).join('\n');
    }
  }

  // 2. All active commitments
  let commitments = 'No active commitments.';
  const rows = db.prepare(`
    SELECT text, owner, project, due_date, state, assigned_to
    FROM commitments
    WHERE state NOT IN ('fulfilled', 'cancelled', 'archived')
    ORDER BY CASE WHEN due_date IS NOT NULL THEN 0 ELSE 1 END, due_date ASC
    LIMIT 40
  `).all() as any[];
  if (rows.length > 0) {
    commitments = rows.map((c: any) => {
      const due = c.due_date ? ` (due: ${c.due_date.slice(0, 10)})` : '';
      return `- [${c.state}] ${c.owner}: ${c.text}${due} — project: ${c.project || 'unassigned'}`;
    }).join('\n');
  }

  // 3. Key entity relationships
  let entities = 'No entity data.';
  const topEntities = db.prepare(`
    SELECT e.canonical_name, e.user_label, e.relationship_type,
      COUNT(DISTINCT k.id) as mentions,
      MAX(k.source_date) as last_seen,
      GROUP_CONCAT(DISTINCT k.project) as projects
    FROM entities e
    JOIN entity_mentions em ON e.id = em.entity_id
    JOIN knowledge k ON em.knowledge_item_id = k.id
    WHERE e.user_dismissed = 0
      AND e.canonical_name NOT LIKE '%Zach%Stock%'
      AND k.source_date >= datetime('now', '-30 days')
      AND e.user_label IS NOT NULL
      AND e.user_label NOT IN ('dismissed', 'noise', 'solicitation')
    GROUP BY e.id
    ORDER BY mentions DESC
    LIMIT 25
  `).all() as any[];
  if (topEntities.length > 0) {
    entities = topEntities.map((e: any) =>
      `- ${e.canonical_name} (${e.user_label || e.relationship_type || 'unknown'}) — ${e.mentions} mentions, last seen ${e.last_seen?.slice(0, 10) || '?'}, projects: ${e.projects || 'none'}`
    ).join('\n');
  }

  return { projects, commitments, entities };
}

const RIPPLE_PROMPT = `You are a strategic impact analyst. A significant event just occurred and you must trace EVERY implication across EVERY project. Think in cascades — first order effects lead to second order effects.

For each affected project:
1. How does this event change the project's status or trajectory?
2. What action should be taken immediately?
3. What downstream effects does this create for OTHER projects?

Return ONLY valid JSON:
{
  "event": "the triggering event",
  "ripples": [
    {
      "project": "project name",
      "impact": "how this event affects this project",
      "new_status": "on_track|at_risk|accelerated|blocked",
      "immediate_action": "what to do right now",
      "downstream": "what this means for other connected projects"
    }
  ],
  "cascading_actions": [
    {
      "priority": 1,
      "title": "action title",
      "type": "email|call|prepare|update",
      "target": "person or null",
      "rationale": "why this action, connected to which ripple"
    }
  ]
}

Requirements:
- Analyze EVERY project — if unaffected, skip it. If affected even indirectly, include it.
- Cascading actions must be ranked by priority (1 = most urgent).
- Think second and third order: if Project A is affected, what does that mean for Project B which depends on the same person?
- Be specific: name people, name projects, name concrete actions.
- If the event has no meaningful impact, return empty ripples/actions arrays.`;

export async function traceRipple(db: Database.Database, event: string): Promise<RippleResult> {
  const { projects, commitments, entities } = assembleRippleContext(db);

  const prompt = `${RIPPLE_PROMPT}

A significant event just occurred: ${event}

Here are all active projects:
${projects}

Here are all active commitments:
${commitments}

Here are key entity relationships:
${entities}

Trace every implication. Return JSON only.`;

  const response = await callClaude(prompt, 300000, PERSISTENT_SESSIONS.ripple);

  // Parse JSON from response
  let result: RippleResult;
  const cleaned = response.replace(/^```(?:json)?\s*\n?/m, '').replace(/\n?```\s*$/m, '').trim();
  try {
    result = JSON.parse(cleaned);
  } catch {
    const objMatch = response.match(/\{[\s\S]*\}/);
    if (objMatch) {
      result = JSON.parse(objMatch[0]);
    } else {
      throw new Error('No valid JSON in ripple response');
    }
  }

  // Store result
  db.prepare(
    "INSERT OR REPLACE INTO graph_state (key, value, updated_at) VALUES ('latest_ripple', ?, datetime('now'))"
  ).run(JSON.stringify(result));

  console.log(`  Ripple: ${result.ripples?.length || 0} projects affected, ${result.cascading_actions?.length || 0} actions generated`);

  return result;
}
