import type Database from 'better-sqlite3';
import { getConfig } from './db.js';
import { getBulkProvider, getDefaultProvider } from './ai/providers.js';
import { retrieveDeepContext } from './source-retrieval.js';
import { searchByFTS } from './db.js';

// ============================================================
// Intelligence Cycle — Strategic Reasoning Engine
//
// This is NOT a data processing pipeline. It's a reasoning system
// that generates knowledge that doesn't exist in any single item.
//
// Phase 1: Situation Modeling (per project)
// Phase 2: Hypothesis Generation (cross-project)
// Phase 3: Evidence Mapping + Red Team
// Phase 4: Implication Chains + Theory of Mind
// Phase 5: Weak Signal Scanner
// Phase 6: Contradiction Detection
// Phase 7: Intelligence Brief Assembly
// ============================================================

interface TaskResult {
  task: string;
  status: 'success' | 'failed' | 'skipped';
  duration_seconds: number;
  output?: any;
  error?: string;
}

interface SituationModel {
  project: string;
  state: string;          // where is this right now
  trajectory: string;     // where is it heading
  constraints: string[];  // what's blocking
  opportunities: string[];// what could unlock
  time_sensitivity: string; // window description
  key_uncertainties: string[]; // what we don't know that matters
  emotional_temperature: string; // relational/emotional state
  key_entities: string[]; // who matters most here
}

interface Hypothesis {
  id: string;
  claim: string;
  type: 'connection' | 'opportunity' | 'threat' | 'prediction' | 'theory_of_mind';
  confidence: number;     // 0-100 after red team
  projects_involved: string[];
  evidence_for: string[];
  evidence_against: string[];
  key_assumption: string; // the ONE thing that if wrong, kills this
  time_sensitivity: string | null;
  action: string;         // what to do about it
  verification: string;   // how to test if this is true
}

interface WeakSignal {
  item_id: string;
  title: string;
  signal: string;
  why_it_matters: string;
  source: string;
  source_date: string;
}

interface Contradiction {
  claim_a: string;
  claim_b: string;
  source_a: string;
  source_b: string;
  entity_or_project: string;
  resolution_needed: string;
}

interface TheoryOfMind {
  entity: string;
  knows: string[];        // what they likely know
  wants: string[];        // their motivations
  constraints: string[];  // what limits them
  recent_behavior: string;
  behavior_hypothesis: string; // why they're acting this way
  likely_next_move: string;
}

interface IntelligenceBrief {
  headline: string;
  situations: SituationModel[];
  hypotheses: Hypothesis[];
  weak_signals: WeakSignal[];
  contradictions: Contradiction[];
  theories_of_mind: TheoryOfMind[];
  the_one_thing: string;  // single highest-leverage action
}

// ── Phase 1: Situation Modeling ──────────────────────────────

async function modelSituations(db: Database.Database): Promise<SituationModel[]> {
  const profilesRaw = (db.prepare("SELECT value FROM graph_state WHERE key = 'project_profiles'").get() as any)?.value;
  if (!profilesRaw) return [];

  const profiles = JSON.parse(profilesRaw);
  const apiKey = getConfig(db, 'openai_api_key');
  const provider = await getBulkProvider(apiKey || undefined);

  // Get recent items, commitments, and relationship momentum per project
  const situations: SituationModel[] = [];

  for (const project of profiles) {
    if (project.status === 'archived' || project.status === 'completed') continue;

    // Gather context for this project
    const recentItems = db.prepare(`
      SELECT title, summary, source, source_date FROM knowledge_primary
      WHERE project = ? AND source_date >= datetime('now', '-14 days')
      ORDER BY source_date DESC LIMIT 10
    `).all(project.project) as any[];

    const commitments = db.prepare(`
      SELECT text, owner, due_date, state FROM commitments
      WHERE project = ? AND state NOT IN ('fulfilled', 'cancelled', 'archived')
      ORDER BY due_date ASC LIMIT 10
    `).all(project.project) as any[];

    const entities = db.prepare(`
      SELECT DISTINCT e.canonical_name, e.user_label, e.relationship_type
      FROM entity_mentions em
      JOIN entities e ON em.entity_id = e.id
      JOIN knowledge k ON em.knowledge_item_id = k.id
      WHERE k.project = ? AND k.source_date >= datetime('now', '-30 days')
        AND e.user_dismissed = 0
      ORDER BY COUNT(*) DESC LIMIT 8
    `).all(project.project) as any[];

    const contextBlock = [
      `Project: ${project.project}`,
      `Current status from last analysis: ${project.status} — ${project.status_reasoning || ''}`,
      `Next action identified: ${project.next_action || 'none'}`,
      '',
      'Recent activity (last 14 days):',
      ...recentItems.map((i: any) => `  [${i.source}] ${i.title}: ${i.summary?.slice(0, 150)}`),
      '',
      'Open commitments:',
      ...commitments.map((c: any) => `  ${c.owner}: ${c.text} (due: ${c.due_date || 'no date'}, state: ${c.state})`),
      '',
      'Key entities:',
      ...entities.map((e: any) => `  ${e.canonical_name} (${e.user_label || e.relationship_type || 'unknown role'})`),
    ].join('\n');

    try {
      const response = await provider.chat([
        { role: 'system', content: `You are a strategic analyst modeling business situations. Output valid JSON only.` },
        { role: 'user', content: `Analyze this project and produce a situation model. Think like a chief of staff who needs to brief the CEO.

${contextBlock}

Return JSON:
{
  "state": "one sentence: where is this project RIGHT NOW",
  "trajectory": "one sentence: where is it HEADING and how fast",
  "constraints": ["what's blocking progress — be specific"],
  "opportunities": ["what could be unlocked — be specific"],
  "time_sensitivity": "description of any windows opening or closing, with dates if known",
  "key_uncertainties": ["things we DON'T KNOW that would change the strategy if we did"],
  "emotional_temperature": "one sentence: relational/emotional state of the key people involved"
}` }
      ], { json: true, temperature: 0.4 });

      const parsed = JSON.parse(response);
      situations.push({
        project: project.project,
        key_entities: entities.map((e: any) => e.canonical_name),
        ...parsed,
      });
    } catch {
      // Skip projects that fail extraction
    }
  }

  return situations;
}

// ── Phase 2: Hypothesis Generation ──────────────────────────

async function generateHypotheses(
  db: Database.Database,
  situations: SituationModel[]
): Promise<Hypothesis[]> {
  if (situations.length < 2) return [];

  const apiKey = getConfig(db, 'openai_api_key');
  // Use Claude for hypothesis generation — this is high-value reasoning
  const provider = await getDefaultProvider(apiKey || undefined);

  // Also pull cross-project patterns and narrative threads
  const patternsRaw = (db.prepare("SELECT value FROM graph_state WHERE key = 'cross_project_patterns'").get() as any)?.value;
  const patterns = patternsRaw ? JSON.parse(patternsRaw) : [];

  const narrativeRaw = (db.prepare("SELECT value FROM graph_state WHERE key = 'world_narrative'").get() as any)?.value;

  // Get the strategic thinking framework
  let strategicFramework = '';
  try {
    const { readFileSync } = await import('fs');
    const { join, dirname } = await import('path');
    const { fileURLToPath } = await import('url');
    const __dirname = dirname(fileURLToPath(import.meta.url));
    strategicFramework = readFileSync(join(__dirname, '..', 'prompts', 'strategic-thinking.md'), 'utf-8');
  } catch {}

  const situationBlock = situations.map(s => `
### ${s.project}
- State: ${s.state}
- Trajectory: ${s.trajectory}
- Constraints: ${s.constraints.join('; ')}
- Opportunities: ${s.opportunities.join('; ')}
- Time sensitivity: ${s.time_sensitivity}
- Key uncertainties: ${s.key_uncertainties.join('; ')}
- Emotional temperature: ${s.emotional_temperature}
- Key people: ${s.key_entities.join(', ')}
`).join('\n');

  const patternBlock = patterns.length > 0
    ? '\nCross-project patterns detected:\n' + patterns.map((p: any) => `- [${p.type}] ${p.insight}`).join('\n')
    : '';

  const response = await provider.chat([
    { role: 'system', content: `You are a strategic intelligence analyst. Your job is to find connections, opportunities, and threats that exist BETWEEN situations — things that no individual project analysis would reveal.

${strategicFramework}

Think like a chess player seeing the whole board, not individual pieces. Generate hypotheses that create NEW knowledge through synthesis.

Output valid JSON only.` },
    { role: 'user', content: `Here are all active business situations:

${situationBlock}
${patternBlock}
${narrativeRaw ? '\nWorld narrative:\n' + narrativeRaw.slice(0, 2000) : ''}

Generate 7-10 hypotheses about what's ACTUALLY happening across these situations. Requirements:
- At least 2 must connect situations from DIFFERENT projects
- At least 2 must be non-obvious or speculative (marked as such)
- At least 1 must be a theory-of-mind hypothesis about a key person's motivations
- Each must state what would have to be TRUE for the hypothesis to be correct
- Each must have a specific verification action

Return JSON array:
[{
  "claim": "one clear sentence stating the hypothesis",
  "type": "connection|opportunity|threat|prediction|theory_of_mind",
  "projects_involved": ["project names"],
  "key_assumption": "the ONE thing that if wrong, kills this hypothesis",
  "time_sensitivity": "urgent/this_week/this_month/none",
  "action": "specific thing to DO about this",
  "verification": "how to TEST if this is true"
}]` }
  ], { json: true, temperature: 0.7, max_tokens: 4000 });

  try {
    const hypotheses = JSON.parse(response);
    return (Array.isArray(hypotheses) ? hypotheses : []).map((h: any, i: number) => ({
      id: `hyp-${Date.now()}-${i}`,
      claim: h.claim,
      type: h.type || 'connection',
      confidence: 50, // Pre-red-team default
      projects_involved: h.projects_involved || [],
      evidence_for: [],
      evidence_against: [],
      key_assumption: h.key_assumption || '',
      time_sensitivity: h.time_sensitivity || null,
      action: h.action || '',
      verification: h.verification || '',
    }));
  } catch {
    return [];
  }
}

// ── Phase 3: Evidence Mapping + Red Team ────────────────────

async function redTeamHypotheses(
  db: Database.Database,
  hypotheses: Hypothesis[],
  situations: SituationModel[]
): Promise<Hypothesis[]> {
  if (hypotheses.length === 0) return [];

  const apiKey = getConfig(db, 'openai_api_key');
  const provider = await getBulkProvider(apiKey || undefined);

  // For each hypothesis, search for supporting and contradicting evidence
  for (const hyp of hypotheses) {
    // Search knowledge base for evidence
    const searchTerms = hyp.claim.split(/\s+/).filter(w => w.length > 4).slice(0, 5).join(' ');
    let evidence: any[] = [];
    try {
      evidence = searchByFTS(db, searchTerms, 10);
    } catch {}

    // Also check commitments and entity data
    for (const proj of hyp.projects_involved) {
      const projCommitments = db.prepare(`
        SELECT text, owner, state, due_date FROM commitments
        WHERE project = ? AND state NOT IN ('fulfilled', 'cancelled', 'archived')
        LIMIT 5
      `).all(proj) as any[];
      evidence.push(...projCommitments.map((c: any) => ({ title: `Commitment: ${c.text}`, summary: `Owner: ${c.owner}, Due: ${c.due_date}, State: ${c.state}` })));
    }

    const evidenceBlock = evidence.map((e: any) =>
      `- [${e.source || 'commitment'}] ${e.title}: ${(e.summary || '').slice(0, 150)}`
    ).join('\n');

    try {
      const response = await provider.chat([
        { role: 'system', content: 'You are a red team analyst. Your job is to CHALLENGE hypotheses. Find holes, contradictions, and alternative explanations. Output valid JSON.' },
        { role: 'user', content: `Hypothesis: "${hyp.claim}"
Key assumption: "${hyp.key_assumption}"

Available evidence:
${evidenceBlock || '(no direct evidence found)'}

Evaluate this hypothesis:
1. What evidence SUPPORTS it? (cite specific items)
2. What evidence CONTRADICTS it or suggests alternatives?
3. What's the SIMPLEST alternative explanation?
4. Confidence score 0-100 (where 50 = coin flip, 80+ = strong)

Return JSON:
{
  "evidence_for": ["specific evidence items that support this"],
  "evidence_against": ["specific evidence or reasoning that contradicts this"],
  "alternative_explanation": "the simplest non-hypothesis explanation",
  "confidence": 65
}` }
      ], { json: true, temperature: 0.3 });

      const rt = JSON.parse(response);
      hyp.evidence_for = rt.evidence_for || [];
      hyp.evidence_against = rt.evidence_against || [];
      hyp.confidence = rt.confidence || 50;
    } catch {
      // Keep default confidence
    }
  }

  // Sort by confidence descending, filter out very low confidence
  return hypotheses
    .filter(h => h.confidence >= 30)
    .sort((a, b) => b.confidence - a.confidence);
}

// ── Phase 4: Implication Chains + Theory of Mind ────────────

async function traceImplications(
  db: Database.Database,
  hypotheses: Hypothesis[]
): Promise<{ chains: any[]; theories: TheoryOfMind[] }> {
  const apiKey = getConfig(db, 'openai_api_key');
  const provider = await getBulkProvider(apiKey || undefined);

  // Implication chains for top 3 hypotheses
  const topHypotheses = hypotheses.slice(0, 3);
  const chains: any[] = [];

  for (const hyp of topHypotheses) {
    try {
      const response = await provider.chat([
        { role: 'system', content: 'You are a strategic analyst tracing implications. Think 3 moves ahead. Output valid JSON.' },
        { role: 'user', content: `Hypothesis (${hyp.confidence}% confidence): "${hyp.claim}"

Trace the implications forward:
- 1st order: What immediately follows if this is true?
- 2nd order: What does THAT lead to?
- 3rd order: What's the strategic endgame?
- Risk: What could derail the chain?
- Time: How long before this plays out?

Return JSON:
{
  "first_order": "immediate consequence",
  "second_order": "what that leads to",
  "third_order": "strategic endgame",
  "risk": "what could break the chain",
  "timeline": "how long this takes to play out",
  "critical_action": "the ONE thing to do if this hypothesis is true"
}` }
      ], { json: true, temperature: 0.4 });

      chains.push({
        hypothesis_id: hyp.id,
        hypothesis: hyp.claim,
        confidence: hyp.confidence,
        ...JSON.parse(response),
      });
    } catch {}
  }

  // Theory of Mind for top entities across active situations
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
    LIMIT 8
  `).all() as any[];

  const theories: TheoryOfMind[] = [];

  for (const entity of topEntities) {
    // Get recent communications involving this entity
    const recentComms = db.prepare(`
      SELECT k.title, k.summary, k.source, k.source_date
      FROM knowledge k
      JOIN entity_mentions em ON k.id = em.knowledge_item_id
      JOIN entities e ON em.entity_id = e.id
      WHERE e.canonical_name = ?
        AND k.source_date >= datetime('now', '-30 days')
      ORDER BY k.source_date DESC LIMIT 8
    `).all(entity.canonical_name) as any[];

    const entityContext = [
      `Entity: ${entity.canonical_name}`,
      `Role: ${entity.user_label || entity.relationship_type || 'unknown'}`,
      `Communication style: ${entity.communication_nature || 'unknown'}`,
      `Reply expectation: ${entity.reply_expectation || 'unknown'}`,
      `Active in projects: ${entity.projects || 'none'}`,
      `Last seen: ${entity.last_seen}`,
      '',
      'Recent communications:',
      ...recentComms.map((c: any) => `  [${c.source} ${c.source_date?.slice(0, 10)}] ${c.title}: ${c.summary?.slice(0, 120)}`),
    ].join('\n');

    try {
      const response = await provider.chat([
        { role: 'system', content: 'You are modeling another person\'s perspective. Think about what THEY know, want, and are constrained by. Output valid JSON.' },
        { role: 'user', content: `${entityContext}

Model this person's current perspective:
- What do they likely KNOW about the situation?
- What do they WANT from this relationship?
- What CONSTRAINTS are they operating under?
- How would you describe their recent behavior pattern?
- What HYPOTHESIS explains their behavior?
- What are they likely to do NEXT?

Return JSON:
{
  "knows": ["what they probably know"],
  "wants": ["their likely motivations"],
  "constraints": ["what limits them"],
  "recent_behavior": "pattern description",
  "behavior_hypothesis": "why they're acting this way",
  "likely_next_move": "what they'll probably do next"
}` }
      ], { json: true, temperature: 0.4 });

      const parsed = JSON.parse(response);
      theories.push({
        entity: entity.canonical_name,
        ...parsed,
      });
    } catch {}
  }

  return { chains, theories };
}

// ── Phase 5: Weak Signal Scanner ────────────────────────────

function scanWeakSignals(db: Database.Database): WeakSignal[] {
  const signals: WeakSignal[] = [];

  // Find items from last 7 days that:
  // 1. Don't belong to any active thread
  // 2. Contain strategic keywords
  // 3. Come from important entities
  const unthreaded = db.prepare(`
    SELECT k.id, k.title, k.summary, k.source, k.source_date, k.contacts, k.project
    FROM knowledge_primary k
    WHERE k.source_date >= datetime('now', '-7 days')
      AND k.id NOT IN (SELECT knowledge_item_id FROM thread_items)
      AND k.source NOT IN ('calendar', 'agent-notification', 'agent-report', 'briefing', 'directive')
      AND (
        k.summary LIKE '%acqui%' OR k.summary LIKE '%restructur%' OR
        k.summary LIKE '%regulat%' OR k.summary LIKE '%fund%' OR
        k.summary LIKE '%deadline%' OR k.summary LIKE '%between us%' OR
        k.summary LIKE '%confidential%' OR k.summary LIKE '%urgent%' OR
        k.summary LIKE '%opportunity%' OR k.summary LIKE '%compet%' OR
        k.summary LIKE '%market shift%' OR k.summary LIKE '%new player%' OR
        k.summary LIKE '%heard that%' OR k.summary LIKE '%rumor%' OR
        k.summary LIKE '%leaving%' OR k.summary LIKE '%joining%' OR
        k.summary LIKE '%pivot%' OR k.summary LIKE '%shut%down%' OR
        k.title LIKE '%acqui%' OR k.title LIKE '%restructur%' OR
        k.title LIKE '%confidential%'
      )
    ORDER BY k.source_date DESC
    LIMIT 15
  `).all() as any[];

  for (const item of unthreaded) {
    signals.push({
      item_id: item.id,
      title: item.title,
      signal: item.summary?.slice(0, 200) || '',
      why_it_matters: `Unthreaded item with strategic keywords from ${item.source}. Not connected to any active project thread.`,
      source: item.source,
      source_date: item.source_date,
    });
  }

  // Find communication anomalies — entities whose frequency changed significantly
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
      HAVING prev_3weeks > 0
    )
    SELECT canonical_name, last_week, prev_3weeks,
      CAST(last_week AS FLOAT) / (prev_3weeks / 3.0) as ratio
    FROM recent
    WHERE (last_week = 0 AND prev_3weeks >= 3) -- went silent
       OR (CAST(last_week AS FLOAT) / (prev_3weeks / 3.0) >= 3.0) -- sudden surge
    ORDER BY ABS(CAST(last_week AS FLOAT) / (prev_3weeks / 3.0) - 1.0) DESC
    LIMIT 10
  `).all() as any[];

  for (const a of anomalies) {
    const pattern = a.last_week === 0 ? 'went silent' : `surged ${a.ratio.toFixed(1)}x`;
    signals.push({
      item_id: '',
      title: `Communication anomaly: ${a.canonical_name} ${pattern}`,
      signal: `${a.canonical_name}: ${a.last_week} mentions last week vs ${a.prev_3weeks} in prior 3 weeks (${pattern})`,
      why_it_matters: a.last_week === 0
        ? `Previously active entity went completely silent. May indicate a relationship change, deal status change, or information they received.`
        : `Sudden increase in communication frequency. May indicate escalation, new development, or increased urgency.`,
      source: 'anomaly_detection',
      source_date: new Date().toISOString(),
    });
  }

  return signals;
}

// ── Phase 6: Contradiction Detection ────────────────────────

function detectContradictions(db: Database.Database): Contradiction[] {
  const contradictions: Contradiction[] = [];

  // Find cases where commitments conflict with evidence
  // e.g., "deal is on track" but "hasn't replied in 2 weeks"
  const activeCommitments = db.prepare(`
    SELECT c.text, c.owner, c.project, c.state, c.due_date,
      e.canonical_name, e.user_label
    FROM commitments c
    LEFT JOIN entities e ON c.owner LIKE '%' || e.canonical_name || '%'
    WHERE c.state IN ('active', 'overdue')
      AND c.due_date IS NOT NULL
      AND c.due_date < datetime('now', '+14 days')
    ORDER BY c.due_date ASC
    LIMIT 20
  `).all() as any[];

  for (const commitment of activeCommitments) {
    if (!commitment.canonical_name) continue;

    // Check if this entity has recent communication
    const lastComm = db.prepare(`
      SELECT MAX(k.source_date) as last_seen
      FROM knowledge k
      JOIN entity_mentions em ON k.id = em.knowledge_item_id
      JOIN entities e ON em.entity_id = e.id
      WHERE e.canonical_name = ?
        AND k.source IN ('gmail', 'gmail-sent', 'cowork', 'claude')
    `).get(commitment.canonical_name) as any;

    if (lastComm?.last_seen) {
      const daysSilent = (Date.now() - new Date(lastComm.last_seen).getTime()) / 86400000;
      if (daysSilent > 7 && commitment.state === 'active') {
        contradictions.push({
          claim_a: `Commitment from ${commitment.canonical_name}: "${commitment.text}" (state: active)`,
          claim_b: `${commitment.canonical_name} hasn't communicated in ${Math.round(daysSilent)} days`,
          source_a: `commitments table (project: ${commitment.project})`,
          source_b: `communication history (last seen: ${lastComm.last_seen?.slice(0, 10)})`,
          entity_or_project: commitment.canonical_name,
          resolution_needed: `Is this commitment still active? The silence may indicate a change in status, a block, or that the commitment was fulfilled through a channel we don't track.`,
        });
      }
    }
  }

  // Find project status contradictions — project marked accelerating but no recent activity
  const profilesRaw = (db.prepare("SELECT value FROM graph_state WHERE key = 'project_profiles'").get() as any)?.value;
  if (profilesRaw) {
    const profiles = JSON.parse(profilesRaw);
    for (const p of profiles) {
      if (p.status === 'accelerating' || p.status === 'active') {
        const recentCount = (db.prepare(
          "SELECT COUNT(*) as c FROM knowledge WHERE project = ? AND source_date >= datetime('now', '-7 days')"
        ).get(p.project) as any)?.c || 0;

        if (recentCount === 0) {
          contradictions.push({
            claim_a: `Project "${p.project}" is marked as ${p.status}`,
            claim_b: `Zero knowledge items in the last 7 days for this project`,
            source_a: 'project_profiles (dream pipeline)',
            source_b: 'knowledge table activity',
            entity_or_project: p.project,
            resolution_needed: `Status may be stale. Either the project status should be downgraded, or activity is happening through channels we don't track.`,
          });
        }
      }
    }
  }

  return contradictions;
}

// ── Phase 7: Intelligence Brief Assembly ────────────────────

async function assembleIntelligenceBrief(
  db: Database.Database,
  situations: SituationModel[],
  hypotheses: Hypothesis[],
  chains: any[],
  theories: TheoryOfMind[],
  weakSignals: WeakSignal[],
  contradictions: Contradiction[]
): Promise<IntelligenceBrief> {
  const apiKey = getConfig(db, 'openai_api_key');
  const provider = await getBulkProvider(apiKey || undefined);

  // Generate the headline and "one thing" from all intelligence
  const briefContext = [
    `SITUATIONS: ${situations.map(s => `${s.project}: ${s.state} (${s.trajectory})`).join('; ')}`,
    `TOP HYPOTHESIS (${hypotheses[0]?.confidence}%): ${hypotheses[0]?.claim || 'none'}`,
    `ACTION: ${hypotheses[0]?.action || 'none'}`,
    `WEAK SIGNALS: ${weakSignals.length} detected`,
    `CONTRADICTIONS: ${contradictions.length} found`,
    `TIME-SENSITIVE: ${hypotheses.filter(h => h.time_sensitivity === 'urgent' || h.time_sensitivity === 'this_week').map(h => h.claim).join('; ') || 'none'}`,
  ].join('\n');

  let headline = '';
  let theOneThing = '';

  try {
    const response = await provider.chat([
      { role: 'system', content: 'You write executive intelligence briefs. One headline, one action. No fluff.' },
      { role: 'user', content: `From this intelligence summary, write:
1. A headline (one sentence, what the CEO needs to know RIGHT NOW)
2. The ONE thing to do today (one specific action, not vague)

${briefContext}

Return JSON: {"headline": "...", "the_one_thing": "..."}` }
    ], { json: true, temperature: 0.3 });

    const parsed = JSON.parse(response);
    headline = parsed.headline || '';
    theOneThing = parsed.the_one_thing || '';
  } catch {
    headline = hypotheses[0]?.claim || 'Intelligence cycle completed';
    theOneThing = hypotheses[0]?.action || 'Review intelligence brief';
  }

  return {
    headline,
    situations,
    hypotheses,
    weak_signals: weakSignals,
    contradictions,
    theories_of_mind: theories,
    the_one_thing: theOneThing,
  };
}

// ── Main Entry Point ────────────────────────────────────────

export async function runIntelligenceCycle(db: Database.Database): Promise<TaskResult> {
  const start = Date.now();
  console.log('    Phase 1: Situation modeling...');

  try {
    // Phase 1: Model each project's situation
    const situations = await modelSituations(db);
    console.log(`      ${situations.length} situations modeled`);

    if (situations.length < 2) {
      return {
        task: '24-intelligence-cycle',
        status: 'skipped',
        duration_seconds: (Date.now() - start) / 1000,
        output: { message: `Only ${situations.length} active situations — need 2+ for cross-project reasoning` },
      };
    }

    // Phase 2: Generate hypotheses across situations
    console.log('    Phase 2: Hypothesis generation...');
    const rawHypotheses = await generateHypotheses(db, situations);
    console.log(`      ${rawHypotheses.length} hypotheses generated`);

    // Phase 3: Red team each hypothesis
    console.log('    Phase 3: Evidence mapping + red team...');
    const hypotheses = await redTeamHypotheses(db, rawHypotheses, situations);
    console.log(`      ${hypotheses.length} survive red team (${rawHypotheses.length - hypotheses.length} eliminated)`);

    // Phase 4: Trace implications + theory of mind
    console.log('    Phase 4: Implication chains + theory of mind...');
    const { chains, theories } = await traceImplications(db, hypotheses);
    console.log(`      ${chains.length} implication chains, ${theories.length} entity models`);

    // Phase 5: Weak signal scan
    console.log('    Phase 5: Weak signal scanner...');
    const weakSignals = scanWeakSignals(db);
    console.log(`      ${weakSignals.length} weak signals detected`);

    // Phase 6: Contradiction detection
    console.log('    Phase 6: Contradiction detection...');
    const contradictions = detectContradictions(db);
    console.log(`      ${contradictions.length} contradictions found`);

    // Phase 7: Assemble intelligence brief
    console.log('    Phase 7: Assembling intelligence brief...');
    const brief = await assembleIntelligenceBrief(
      db, situations, hypotheses, chains, theories, weakSignals, contradictions
    );

    // Store everything in graph_state
    db.prepare(
      "INSERT OR REPLACE INTO graph_state (key, value, updated_at) VALUES ('intelligence_brief', ?, datetime('now'))"
    ).run(JSON.stringify(brief));

    db.prepare(
      "INSERT OR REPLACE INTO graph_state (key, value, updated_at) VALUES ('situation_models', ?, datetime('now'))"
    ).run(JSON.stringify(situations));

    db.prepare(
      "INSERT OR REPLACE INTO graph_state (key, value, updated_at) VALUES ('active_hypotheses', ?, datetime('now'))"
    ).run(JSON.stringify(hypotheses));

    db.prepare(
      "INSERT OR REPLACE INTO graph_state (key, value, updated_at) VALUES ('implication_chains', ?, datetime('now'))"
    ).run(JSON.stringify(chains));

    db.prepare(
      "INSERT OR REPLACE INTO graph_state (key, value, updated_at) VALUES ('theories_of_mind', ?, datetime('now'))"
    ).run(JSON.stringify(theories));

    db.prepare(
      "INSERT OR REPLACE INTO graph_state (key, value, updated_at) VALUES ('weak_signals', ?, datetime('now'))"
    ).run(JSON.stringify(weakSignals));

    db.prepare(
      "INSERT OR REPLACE INTO graph_state (key, value, updated_at) VALUES ('detected_contradictions', ?, datetime('now'))"
    ).run(JSON.stringify(contradictions));

    // Track hypotheses for meta-learning (append to history)
    const historyRaw = (db.prepare("SELECT value FROM graph_state WHERE key = 'hypothesis_history'").get() as any)?.value;
    const history = historyRaw ? JSON.parse(historyRaw) : [];
    for (const h of hypotheses) {
      history.push({
        ...h,
        generated_at: new Date().toISOString(),
        verified: null, // Will be updated by prediction verification task
      });
    }
    // Keep last 100 hypotheses
    const trimmedHistory = history.slice(-100);
    db.prepare(
      "INSERT OR REPLACE INTO graph_state (key, value, updated_at) VALUES ('hypothesis_history', ?, datetime('now'))"
    ).run(JSON.stringify(trimmedHistory));

    return {
      task: '24-intelligence-cycle',
      status: 'success',
      duration_seconds: (Date.now() - start) / 1000,
      output: {
        situations: situations.length,
        hypotheses_generated: rawHypotheses.length,
        hypotheses_surviving: hypotheses.length,
        top_hypothesis: hypotheses[0] ? `${hypotheses[0].claim} (${hypotheses[0].confidence}%)` : 'none',
        implication_chains: chains.length,
        theories_of_mind: theories.length,
        weak_signals: weakSignals.length,
        contradictions: contradictions.length,
        headline: brief.headline,
        the_one_thing: brief.the_one_thing,
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
