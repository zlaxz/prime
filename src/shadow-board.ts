/**
 * Shadow Board — Four parallel AI advisors evaluate any decision simultaneously.
 * CFO, Risk Officer, Strategist, Relationship Manager + synthesis.
 */

import Database from 'better-sqlite3';
import { callClaude } from './dream.js';

interface ShadowBoardResult {
  decision: string;
  advisors: {
    cfo: { assessment: string; recommendation: string; key_concern: string };
    risk: { assessment: string; risk_level: number; top_risk: string; mitigation: string };
    strategist: { assessment: string; strategic_value: string; opportunity: string };
    relationship: { assessment: string; affected_people: string[]; recommended_communication: string };
  };
  consensus: string;
  synthesis: string;
}

const ADVISORS = {
  cfo: `You are the CFO advisor. Evaluate this decision purely on financial merit. What does it cost? What's the ROI? What's the payback period? What financial risks exist? Be specific with numbers where possible.

Respond in this exact JSON format:
{"assessment": "...", "recommendation": "proceed|caution|reject", "key_concern": "..."}`,

  risk: `You are the Risk Officer. What could go wrong with this decision? What's the worst case? What's the blast radius if it fails? What relationships could be damaged? What legal or regulatory risks exist? Rate the risk 1-10.

Respond in this exact JSON format:
{"assessment": "...", "risk_level": <1-10>, "top_risk": "...", "mitigation": "..."}`,

  strategist: `You are the Growth Strategist. How does this decision connect to the 3-year vision? Does it create leverage for future moves? Is this a one-time play or does it compound? What's the 10x version of this decision?

Respond in this exact JSON format:
{"assessment": "...", "strategic_value": "high|medium|low", "opportunity": "..."}`,

  relationship: `You are the Relationship Manager. Who is affected by this decision? Who feels valued? Who might feel blindsided or left out? What's the emotional impact on key relationships? Who should be informed before this happens?

Respond in this exact JSON format:
{"assessment": "...", "affected_people": ["name1", "name2"], "recommended_communication": "..."}`,
} as const;

function getBusinessContext(db: Database.Database): string {
  const sections: string[] = [];

  // Project profiles
  const profiles = (db.prepare("SELECT value FROM graph_state WHERE key = 'project_profiles'").get() as any)?.value;
  if (profiles) {
    try {
      const parsed = JSON.parse(profiles);
      const lines = Object.entries(parsed).map(([k, v]: [string, any]) => `- ${k}: ${v.status || 'unknown'} — ${v.description || ''}`);
      if (lines.length) sections.push(`ACTIVE PROJECTS:\n${lines.join('\n')}`);
    } catch (_e) {}
  }

  // Key entities
  const entities = db.prepare("SELECT canonical_name AS name, relationship_type AS type FROM entities WHERE user_dismissed = 0 ORDER BY last_seen_date DESC LIMIT 20").all() as any[];
  if (entities.length) {
    sections.push(`KEY PEOPLE/ORGS:\n${entities.map((e: any) => `- ${e.name} (${e.type})`).join('\n')}`);
  }

  // Active commitments
  const commitments = db.prepare("SELECT text, owner, due_date FROM commitments WHERE state = 'active' ORDER BY due_date LIMIT 10").all() as any[];
  if (commitments.length) {
    sections.push(`ACTIVE COMMITMENTS:\n${commitments.map((c: any) => `- ${c.text} (owner: ${c.owner || 'unassigned'}${c.due_date ? ', due: ' + c.due_date : ''})`).join('\n')}`);
  }

  return sections.length ? sections.join('\n\n') : 'No business context available.';
}

function parseAdvisorResponse(raw: string): any {
  // Extract JSON from response — advisor may wrap it in markdown
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    try { return JSON.parse(jsonMatch[0]); } catch (_e) {}
  }
  return { assessment: raw, error: 'Could not parse structured response' };
}

export async function evaluateDecision(db: Database.Database, decision: string, context?: string): Promise<ShadowBoardResult> {
  const bizContext = getBusinessContext(db);
  const fullContext = [bizContext, context ? `ADDITIONAL CONTEXT:\n${context}` : ''].filter(Boolean).join('\n\n');

  const buildPrompt = (persona: string) =>
    `${persona}\n\nBUSINESS CONTEXT:\n${fullContext}\n\nDECISION TO EVALUATE:\n${decision}\n\nRespond ONLY with the JSON object. No other text.`;

  // Run all 4 advisors in parallel
  const [cfoRaw, riskRaw, stratRaw, relRaw] = await Promise.all([
    callClaude(buildPrompt(ADVISORS.cfo), 60000),
    callClaude(buildPrompt(ADVISORS.risk), 60000),
    callClaude(buildPrompt(ADVISORS.strategist), 60000),
    callClaude(buildPrompt(ADVISORS.relationship), 60000),
  ]);

  const advisors = {
    cfo: parseAdvisorResponse(cfoRaw),
    risk: parseAdvisorResponse(riskRaw),
    strategist: parseAdvisorResponse(stratRaw),
    relationship: parseAdvisorResponse(relRaw),
  };

  // Synthesis — 5th call reads all four
  const synthesisPrompt = `You are the board secretary synthesizing four advisor assessments of this decision: "${decision}"

CFO: ${JSON.stringify(advisors.cfo)}
Risk Officer: ${JSON.stringify(advisors.risk)}
Strategist: ${JSON.stringify(advisors.strategist)}
Relationship Manager: ${JSON.stringify(advisors.relationship)}

Produce a JSON response with:
- "consensus": one of "proceed", "mixed", "caution", or "reject" based on the balance of advisor opinions
- "synthesis": one paragraph (3-5 sentences) combining all four perspectives into a unified recommendation

Respond ONLY with the JSON object.`;

  const synthRaw = await callClaude(synthesisPrompt, 60000);
  const synth = parseAdvisorResponse(synthRaw);

  return {
    decision,
    advisors,
    consensus: synth.consensus || 'mixed',
    synthesis: synth.synthesis || 'Synthesis unavailable — review individual advisor assessments.',
  };
}
