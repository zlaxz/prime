import type Database from 'better-sqlite3';
import { callClaude } from './dream.js';
import { getConfig, insertKnowledge } from './db.js';
import { v4 as uuid } from 'uuid';

// ============================================================
// Playbook Extractor — Distills reusable patterns from experience
//
// The system sees every conversation, correction, and multi-step workflow.
// This task asks: "What reusable pattern can be extracted?"
// and stores it as a structured playbook.
//
// Playbooks ARE semantic memory — generalized principles from episodic experience.
// "You drafted 4 email iterations learning stakeholder analysis" →
// "PLAYBOOK: When emailing someone's investor, always position as helping the founder"
// ============================================================

interface TaskResult {
  task: string;
  status: 'success' | 'failed' | 'skipped';
  duration_seconds: number;
  output?: any;
  error?: string;
}

interface Playbook {
  id: string;
  title: string;
  trigger: string;       // When to use this playbook
  steps: string[];        // What to do, in order
  why: string;            // Why this works
  pitfalls: string[];     // What to avoid
  source_events: string[]; // What experiences generated this
  created_at: string;
}

const PLAYBOOK_PROMPT = `You are analyzing recent business activity to extract REUSABLE PLAYBOOKS — patterns that can be applied again in similar situations.

A playbook is NOT a summary of what happened. It's a RECIPE for how to handle similar situations in the future. Think: "If this situation comes up again, here's exactly what to do and what to avoid."

Review the recent activity and extract 1-3 playbooks. Only extract playbooks for situations that:
1. Involved multiple steps or iterations (not simple one-off tasks)
2. Had corrections or learning moments (something was improved through iteration)
3. Are likely to recur (not one-time unique events)

Return JSON:
{
  "playbooks": [
    {
      "title": "Short descriptive name (e.g., 'Investor Outreach Protocol')",
      "trigger": "When to use this playbook — the situation that activates it",
      "steps": [
        "Step 1: specific action",
        "Step 2: specific action"
      ],
      "why": "Why this approach works — the principle behind it",
      "pitfalls": [
        "What to avoid — lessons learned from mistakes"
      ],
      "source_events": [
        "Brief description of the experience this was extracted from"
      ]
    }
  ]
}

If no recent activity warrants a playbook, return: {"playbooks": []}
Do NOT force playbooks from routine activity. Only extract when there's genuine learning.`;

export async function extractPlaybooks(db: Database.Database): Promise<TaskResult> {
  const start = Date.now();

  try {
    // Gather recent learning signals
    const signals: string[] = [];

    // 1. Recent user corrections (highest signal — user explicitly said "do it differently")
    const corrections = db.prepare(`
      SELECT title, summary, source_date FROM knowledge
      WHERE source IN ('correction', 'user-feedback') AND source_date >= datetime('now', '-3 days')
      ORDER BY source_date DESC LIMIT 10
    `).all() as any[];

    if (corrections.length > 0) {
      signals.push('## USER CORRECTIONS (last 3 days)\n');
      for (const c of corrections) {
        signals.push(`- [${c.source_date?.slice(0, 10)}] ${c.title}: ${c.summary?.slice(0, 200)}`);
      }
      signals.push('');
    }

    // 2. Recent decisions (explicit strategic choices)
    const decisions = db.prepare(`
      SELECT decision, reasoning, category, project FROM decisions
      WHERE active = 1 AND created_at >= datetime('now', '-3 days')
      ORDER BY created_at DESC LIMIT 10
    `).all() as any[];

    if (decisions.length > 0) {
      signals.push('## RECENT DECISIONS\n');
      for (const d of decisions) {
        signals.push(`- [${d.category}] ${d.decision} — ${d.reasoning || ''}`);
      }
      signals.push('');
    }

    // 3. Recent high-importance manual items (things Zach explicitly remembered)
    const manualItems = db.prepare(`
      SELECT title, summary, source_date FROM knowledge
      WHERE source = 'manual' AND importance IN ('critical', 'high')
        AND source_date >= datetime('now', '-3 days')
      ORDER BY source_date DESC LIMIT 10
    `).all() as any[];

    if (manualItems.length > 0) {
      signals.push('## MANUALLY SAVED ITEMS (high importance)\n');
      for (const m of manualItems) {
        signals.push(`- [${m.source_date?.slice(0, 10)}] ${m.title}: ${m.summary?.slice(0, 200)}`);
      }
      signals.push('');
    }

    // 4. Recent strategic lessons
    const lessons = db.prepare(`
      SELECT lesson, lesson_type, correction_rule FROM strategic_lessons
      WHERE lesson_date >= date('now', '-3 days')
      ORDER BY lesson_date DESC LIMIT 10
    `).all() as any[];

    if (lessons.length > 0) {
      signals.push('## STRATEGIC LESSONS\n');
      for (const l of lessons) {
        signals.push(`- [${l.lesson_type}] ${l.lesson} → Rule: ${l.correction_rule?.slice(0, 150) || ''}`);
      }
      signals.push('');
    }

    // 5. Existing playbooks (so we don't duplicate)
    const existingPlaybooks = db.prepare(`
      SELECT title FROM knowledge WHERE source = 'playbook'
      ORDER BY source_date DESC LIMIT 20
    `).all() as any[];

    if (existingPlaybooks.length > 0) {
      signals.push('## EXISTING PLAYBOOKS (do not duplicate)\n');
      for (const p of existingPlaybooks) {
        signals.push(`- ${p.title}`);
      }
      signals.push('');
    }

    const context = signals.join('\n');

    if (context.length < 200) {
      return { task: '26-playbook-extractor', status: 'skipped', duration_seconds: 0,
        output: { message: 'Insufficient learning signals for playbook extraction' } };
    }

    // Ask Claude to extract playbooks
    const response = await callClaude(
      `${PLAYBOOK_PROMPT}\n\n---\n\nRecent activity to analyze:\n\n${context}`,
      120000
    );

    // Parse response
    const jsonStart = response.indexOf('{');
    if (jsonStart === -1) {
      return { task: '26-playbook-extractor', status: 'skipped', duration_seconds: (Date.now() - start) / 1000,
        output: { message: 'No playbooks extracted' } };
    }

    let parsed: any;
    for (let end = response.length; end > jsonStart; end--) {
      if (response[end - 1] !== '}') continue;
      try { parsed = JSON.parse(response.slice(jsonStart, end)); break; } catch (_e) {}
    }

    const playbooks: Playbook[] = (parsed?.playbooks || []).map((p: any) => ({
      id: uuid(),
      title: p.title,
      trigger: p.trigger,
      steps: p.steps || [],
      why: p.why,
      pitfalls: p.pitfalls || [],
      source_events: p.source_events || [],
      created_at: new Date().toISOString(),
    }));

    if (playbooks.length === 0) {
      return { task: '26-playbook-extractor', status: 'skipped', duration_seconds: (Date.now() - start) / 1000,
        output: { message: 'No reusable patterns found in recent activity' } };
    }

    // Store each playbook in the knowledge base
    for (const pb of playbooks) {
      const content = [
        `# PLAYBOOK: ${pb.title}`,
        '',
        `**TRIGGER:** ${pb.trigger}`,
        '',
        '**STEPS:**',
        ...pb.steps.map((s, i) => `${i + 1}. ${s}`),
        '',
        `**WHY:** ${pb.why}`,
        '',
        '**PITFALLS:**',
        ...pb.pitfalls.map(p => `- ${p}`),
        '',
        '**EXTRACTED FROM:**',
        ...pb.source_events.map(e => `- ${e}`),
      ].join('\n');

      insertKnowledge(db, {
        id: pb.id,
        title: `PLAYBOOK: ${pb.title}`,
        summary: `Trigger: ${pb.trigger}. ${pb.steps.length} steps. Why: ${pb.why?.slice(0, 100)}`,
        source: 'playbook',
        source_ref: `playbook:${pb.id}`,
        source_date: new Date().toISOString(),
        tags: ['playbook', 'semantic-memory', 'reusable-pattern'],
        importance: 'high',
        metadata: {
          trigger: pb.trigger,
          steps: pb.steps,
          why: pb.why,
          pitfalls: pb.pitfalls,
          source_events: pb.source_events,
        },
      });
    }

    // Store in graph_state for easy access
    const allPlaybooks = db.prepare(
      "SELECT title, summary, metadata FROM knowledge WHERE source = 'playbook' ORDER BY source_date DESC LIMIT 50"
    ).all() as any[];

    db.prepare(
      "INSERT OR REPLACE INTO graph_state (key, value, updated_at) VALUES ('active_playbooks', ?, datetime('now'))"
    ).run(JSON.stringify(allPlaybooks));

    return {
      task: '26-playbook-extractor',
      status: 'success',
      duration_seconds: (Date.now() - start) / 1000,
      output: {
        playbooks_extracted: playbooks.length,
        titles: playbooks.map(p => p.title),
        total_playbooks: allPlaybooks.length,
      },
    };
  } catch (err: any) {
    return { task: '26-playbook-extractor', status: 'failed', duration_seconds: (Date.now() - start) / 1000, error: err.message };
  }
}
