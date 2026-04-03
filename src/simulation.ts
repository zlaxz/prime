import type Database from 'better-sqlite3';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { callClaude } from './dream.js';
import { v4 as uuidv4 } from 'uuid';

// ============================================================
// Simulation Room — Conversation Simulator
//
// Practice negotiations and difficult conversations with
// simulated counterparties. Prime builds their persona from
// entity intelligence — motivations, constraints, communication
// style, and likely responses.
//
// Uses callClaude with persistent sessions so multi-turn
// conversations accumulate naturally.
// ============================================================

interface SimulationResult {
  response: string;
  session_id: string;
  entity: string;
  scenario: string;
  turn: number;
}

// ── Load voice profile for Zach's side ─────────────────────

function loadVoiceProfile(): string {
  const voicePath = join(homedir(), 'GitHub', 'prime', 'prompts', 'voice-profile.md');
  if (existsSync(voicePath)) {
    return readFileSync(voicePath, 'utf-8');
  }
  return '';
}

// ── Load entity intelligence from the knowledge base ───────

function loadEntityIntelligence(db: Database.Database, entityName: string): {
  profile: any;
  theoryOfMind: any;
  recentComms: any[];
  entityRow: any;
} {
  // 1. Find the entity
  const entityRow = db.prepare(`
    SELECT e.id, e.canonical_name, e.user_label, e.relationship_type
    FROM entities e
    WHERE e.canonical_name LIKE ? OR e.canonical_name LIKE ?
    ORDER BY
      CASE WHEN e.canonical_name = ? THEN 0
           WHEN e.canonical_name LIKE ? THEN 1
           ELSE 2 END
    LIMIT 1
  `).get(
    `%${entityName}%`,
    `%${entityName}%`,
    entityName,
    `${entityName}%`
  ) as any;

  if (!entityRow) {
    return { profile: null, theoryOfMind: null, recentComms: [], entityRow: null };
  }

  // 2. Load entity profile
  const profile = db.prepare(`
    SELECT communication_nature, reply_expectation, email_types,
           importance_to_business, importance_evidence, relationship_evidence
    FROM entity_profiles
    WHERE entity_id = ?
  `).get(entityRow.id) as any;

  // 3. Load theory of mind from graph_state
  let theoryOfMind: any = null;
  const theoriesRaw = (db.prepare(
    "SELECT value FROM graph_state WHERE key = 'theories_of_mind'"
  ).get() as any)?.value;

  if (theoriesRaw) {
    try {
      const theories = JSON.parse(theoriesRaw);
      theoryOfMind = theories.find((t: any) =>
        t.entity?.toLowerCase().includes(entityName.toLowerCase()) ||
        entityName.toLowerCase().includes(t.entity?.toLowerCase())
      );
    } catch {}
  }

  // 4. Load recent communication history (last 10 items via entity_mentions)
  const recentComms = db.prepare(`
    SELECT k.title, k.summary, k.source, k.source_date, k.raw_content
    FROM entity_mentions em
    JOIN knowledge k ON em.knowledge_item_id = k.id
    WHERE em.entity_id = ?
    ORDER BY k.source_date DESC
    LIMIT 10
  `).all(entityRow.id) as any[];

  return { profile, theoryOfMind, recentComms, entityRow };
}

// ── Build the simulation prompt ────────────────────────────

function buildSimulationPrompt(
  entityName: string,
  scenario: string,
  userMessage: string,
  intelligence: ReturnType<typeof loadEntityIntelligence>,
  voiceProfile: string,
): string {
  const { profile, theoryOfMind, recentComms, entityRow } = intelligence;

  const sections: string[] = [];

  sections.push(`You are roleplaying as ${entityName}. You must stay FULLY in character for the entire conversation. Never break character. Never acknowledge you are an AI.`);
  sections.push('');

  // Entity identity
  if (entityRow) {
    sections.push(`## WHO YOU ARE`);
    sections.push(`Name: ${entityRow.canonical_name}`);
    if (entityRow.user_label) sections.push(`Role/Label: ${entityRow.user_label}`);
    if (entityRow.relationship_type) sections.push(`Relationship to Zach: ${entityRow.relationship_type}`);
    sections.push('');
  }

  // Theory of mind — the richest source
  if (theoryOfMind) {
    sections.push(`## YOUR INNER STATE (what drives you)`);
    if (theoryOfMind.knows?.length) {
      sections.push(`What you know: ${Array.isArray(theoryOfMind.knows) ? theoryOfMind.knows.join('; ') : theoryOfMind.knows}`);
    }
    if (theoryOfMind.wants?.length) {
      sections.push(`What you want: ${Array.isArray(theoryOfMind.wants) ? theoryOfMind.wants.join('; ') : theoryOfMind.wants}`);
    }
    if (theoryOfMind.constraints?.length) {
      sections.push(`Your constraints: ${Array.isArray(theoryOfMind.constraints) ? theoryOfMind.constraints.join('; ') : theoryOfMind.constraints}`);
    }
    if (theoryOfMind.behavior_hypothesis) {
      sections.push(`Your behavioral pattern: ${theoryOfMind.behavior_hypothesis}`);
    }
    if (theoryOfMind.likely_next_move) {
      sections.push(`Your likely next move: ${theoryOfMind.likely_next_move}`);
    }
    sections.push('');
  }

  // Communication profile
  if (profile) {
    sections.push(`## YOUR COMMUNICATION STYLE`);
    if (profile.communication_nature && profile.communication_nature !== 'unknown') {
      sections.push(`Nature: ${profile.communication_nature}`);
    }
    if (profile.reply_expectation && profile.reply_expectation !== 'unknown') {
      sections.push(`Reply pattern: ${profile.reply_expectation}`);
    }
    if (profile.importance_to_business && profile.importance_to_business !== 'unknown') {
      sections.push(`Business importance: ${profile.importance_to_business}`);
    }
    if (profile.importance_evidence) {
      sections.push(`Why important: ${profile.importance_evidence}`);
    }
    if (profile.relationship_evidence) {
      sections.push(`Relationship context: ${profile.relationship_evidence}`);
    }
    sections.push('');
  }

  // Recent communications — gives flavor for how they actually talk
  if (recentComms.length > 0) {
    sections.push(`## RECENT INTERACTIONS (use these to calibrate your tone and knowledge)`);
    for (const comm of recentComms) {
      const date = comm.source_date?.slice(0, 10) || 'unknown';
      const content = comm.raw_content
        ? comm.raw_content.slice(0, 300)
        : comm.summary?.slice(0, 200) || '';
      sections.push(`[${date} ${comm.source}] ${comm.title}`);
      sections.push(`  ${content}`);
    }
    sections.push('');
  }

  // Voice profile context — so the simulation knows Zach's style
  if (voiceProfile) {
    sections.push(`## ABOUT THE PERSON YOU'RE TALKING TO (Zach Stock)`);
    sections.push(voiceProfile);
    sections.push('');
  }

  // Instructions
  sections.push(`## SIMULATION RULES`);
  sections.push(`1. Stay in character as ${entityName} at ALL times.`);
  sections.push(`2. Respond as they would — push back where they would push back, concede where they would concede.`);
  sections.push(`3. Reference specific details from your known context (deals, prior conversations, shared history).`);
  sections.push(`4. Match their communication style — if they're direct, be direct. If they're cautious, be cautious.`);
  sections.push(`5. Have realistic motivations. Don't be a pushover. Don't be unnecessarily hostile.`);
  sections.push(`6. If the scenario involves a negotiation, have a realistic bottom line based on their known constraints.`);
  sections.push(`7. React to what Zach says, not what you think he should say.`);
  sections.push('');

  // Scenario
  sections.push(`## SCENARIO`);
  sections.push(scenario);
  sections.push('');

  // The user's message
  sections.push(`## ZACH SAYS:`);
  sections.push(userMessage);
  sections.push('');
  sections.push(`Respond as ${entityName} would. Stay in character.`);

  return sections.join('\n');
}

// ── Session management ─────────────────────────────────────

function getSimulationSessionKey(entityName: string): string {
  // Normalize entity name for consistent session keys
  const normalized = entityName.toLowerCase().replace(/[^a-z0-9]/g, '_');
  return `simulation_session_${normalized}`;
}

function getSimulationSession(db: Database.Database, entityName: string): {
  sessionId: string | undefined;
  turn: number;
} {
  const key = getSimulationSessionKey(entityName);
  const row = (db.prepare("SELECT value FROM graph_state WHERE key = ?").get(key) as any)?.value;
  if (row) {
    try {
      const data = JSON.parse(row);
      return { sessionId: data.session_id, turn: data.turn || 0 };
    } catch {}
  }
  return { sessionId: undefined, turn: 0 };
}

function saveSimulationSession(db: Database.Database, entityName: string, sessionId: string, turn: number): void {
  const key = getSimulationSessionKey(entityName);
  db.prepare(
    "INSERT OR REPLACE INTO graph_state (key, value, updated_at) VALUES (?, ?, datetime('now'))"
  ).run(key, JSON.stringify({ session_id: sessionId, turn, entity: entityName, updated_at: new Date().toISOString() }));
}

// ── Main entry point ───────────────────────────────────────

export async function runSimulation(
  db: Database.Database,
  entityName: string,
  scenario: string,
  userMessage?: string,
): Promise<SimulationResult> {
  // Load all intelligence about this entity
  const intelligence = loadEntityIntelligence(db, entityName);
  const voiceProfile = loadVoiceProfile();

  if (!intelligence.entityRow) {
    throw new Error(`Entity "${entityName}" not found in the knowledge base. Search for the correct name with prime_search.`);
  }

  // Resolve the canonical name
  const canonicalName = intelligence.entityRow.canonical_name;

  // Get or create persistent session
  const { sessionId: existingSessionId, turn: existingTurn } = getSimulationSession(db, canonicalName);

  // Determine the message to send
  const message = userMessage || `[Starting simulation] Hi ${canonicalName.split(' ')[0]}, I wanted to talk about something.`;

  // For continuation (multi-turn): just send the user's message with minimal framing
  // For first turn: send the full simulation prompt with all context
  let prompt: string;
  let sessionId: string | undefined;
  let turn: number;

  if (existingSessionId && userMessage) {
    // Multi-turn continuation — context is already in the session
    prompt = `Zach says: ${message}\n\nRespond as ${canonicalName} would. Stay in character.`;
    sessionId = existingSessionId;
    turn = existingTurn + 1;
  } else {
    // New simulation — build full prompt
    prompt = buildSimulationPrompt(canonicalName, scenario, message, intelligence, voiceProfile);
    // Generate a new dedicated session ID for this simulation
    sessionId = uuidv4();
    turn = 1;
  }

  // Call Claude with persistent session
  const response = await callClaude(prompt, 120000, sessionId);

  // After the call, capture the session ID
  // callClaude stores the session in graph_state['last_claude_session_id'] when new
  // For new sessions, use the UUID we generated (it was passed to callClaude)
  const finalSessionId = sessionId || uuidv4();

  // Save session state for multi-turn
  saveSimulationSession(db, canonicalName, finalSessionId, turn);

  return {
    response: response.trim(),
    session_id: finalSessionId,
    entity: canonicalName,
    scenario,
    turn,
  };
}

// ── Reset a simulation (start fresh) ──────────────────────

export function resetSimulation(db: Database.Database, entityName: string): void {
  const key = getSimulationSessionKey(entityName);
  db.prepare("DELETE FROM graph_state WHERE key = ?").run(key);
}
