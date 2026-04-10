import type Database from 'better-sqlite3';
import { callClaude } from './dream.js';
import { getConfig, insertKnowledge } from './db.js';
import { v4 as uuid } from 'uuid';

// ============================================================
// Autonomous Research Engine — Task 25
//
// Reads research_queue from intelligence cycle, uses web search
// to find answers, stores findings in knowledge base, updates
// hypothesis confidence.
//
// The system doesn't just process what comes in.
// It hunts for what it needs.
// ============================================================

interface ResearchQuestion {
  question: string;
  hypothesis_id?: string;
  search_terms: string;
  priority: string;
  why: string;
}

interface ResearchFinding {
  question: string;
  answer: string;
  sources: string[];
  confidence: string;
  impact: string;
}

interface TaskResult {
  task: string;
  status: 'success' | 'failed' | 'skipped';
  duration_seconds: number;
  output?: any;
  error?: string;
}

export async function runAutonomousResearch(db: Database.Database): Promise<TaskResult> {
  const start = Date.now();

  try {
    // Load research queue from intelligence cycle
    const queueRaw = (db.prepare("SELECT value FROM graph_state WHERE key = 'research_queue'").get() as any)?.value;
    if (!queueRaw) {
      return { task: '25-autonomous-research', status: 'skipped', duration_seconds: 0, output: { message: 'No research queue' } };
    }

    const queue: ResearchQuestion[] = JSON.parse(queueRaw);
    if (queue.length === 0) {
      return { task: '25-autonomous-research', status: 'skipped', duration_seconds: 0, output: { message: 'Research queue empty' } };
    }

    // Check if we already researched recently (throttle to once per 4 hours)
    const lastResearch = (db.prepare("SELECT value FROM graph_state WHERE key = 'last_research_run'").get() as any)?.value;
    if (lastResearch) {
      const hoursSince = (Date.now() - new Date(JSON.parse(lastResearch)).getTime()) / 3600000;
      if (hoursSince < 4) {
        return { task: '25-autonomous-research', status: 'skipped', duration_seconds: 0,
          output: { message: `Researched ${hoursSince.toFixed(1)}h ago, throttled to 4h` } };
      }
    }

    console.log(`    Researching ${queue.length} questions...`);
    const findings: ResearchFinding[] = [];

    // Research top 3 questions (most impactful, avoid burning too many calls)
    const topQuestions = queue
      .sort((a, b) => {
        const order: Record<string, number> = { critical: 0, high: 1, medium: 2 };
        return (order[a.priority] ?? 2) - (order[b.priority] ?? 2);
      })
      .slice(0, 3);

    for (const q of topQuestions) {
      try {
        console.log(`      Researching: ${q.question.slice(0, 80)}`);

        // Use callClaude with web search capability
        // The prompt explicitly asks for web research
        const response = await callClaude(
          `You are a research analyst. Answer this specific factual question using web search.

QUESTION: ${q.question}

SEARCH TERMS TO TRY: ${q.search_terms}

WHY THIS MATTERS: ${q.why}

Instructions:
1. Search the web for current, factual information
2. Focus on verifiable facts, not opinions
3. Cite your sources
4. Rate your confidence in the answer (high/medium/low)
5. Explain how this finding changes the strategic picture

Return JSON:
{
  "answer": "Clear factual answer based on what you found",
  "sources": ["URLs or source descriptions"],
  "confidence": "high|medium|low",
  "impact": "How this changes the analysis — what should be updated based on this finding"
}`,
          120000 // 2 min timeout per question
        );

        // Parse the finding
        const jsonStart = response.indexOf('{');
        if (jsonStart >= 0) {
          let parsed = false;
          for (let end = response.length; end > jsonStart; end--) {
            if (response[end - 1] !== '}') continue;
            try {
              const finding = JSON.parse(response.slice(jsonStart, end));
              findings.push({
                question: q.question,
                answer: finding.answer || response,
                sources: finding.sources || [],
                confidence: finding.confidence || 'low',
                impact: finding.impact || '',
              });
              parsed = true;
              break;
            } catch (_e) {}
          }
          if (!parsed) {
            findings.push({
              question: q.question,
              answer: response.slice(0, 500),
              sources: [],
              confidence: 'low',
              impact: '',
            });
          }
        }

        // Store finding in knowledge base
        insertKnowledge(db, {
          id: uuid(),
          title: `RESEARCH: ${q.question.slice(0, 100)}`,
          summary: findings[findings.length - 1]?.answer?.slice(0, 500) || 'Research completed',
          source: 'autonomous-research',
          source_ref: `research:${uuid()}`,
          source_date: new Date().toISOString(),
          tags: ['autonomous-research', `priority:${q.priority}`],
          importance: q.priority === 'critical' ? 'high' : 'normal',
          metadata: {
            question: q.question,
            search_terms: q.search_terms,
            hypothesis_id: q.hypothesis_id,
            why: q.why,
            sources: findings[findings.length - 1]?.sources || [],
            confidence: findings[findings.length - 1]?.confidence || 'low',
          },
        });

        console.log(`      Found: ${findings[findings.length - 1]?.answer?.slice(0, 80)}`);
      } catch (err: any) {
        console.log(`      Failed: ${err.message?.slice(0, 60)}`);
      }
    }

    // Store research report
    db.prepare(
      "INSERT OR REPLACE INTO graph_state (key, value, updated_at) VALUES ('research_findings', ?, datetime('now'))"
    ).run(JSON.stringify(findings));

    db.prepare(
      "INSERT OR REPLACE INTO graph_state (key, value, updated_at) VALUES ('last_research_run', ?, datetime('now'))"
    ).run(JSON.stringify(new Date().toISOString()));

    // Clear the queue (it'll be regenerated on next intelligence cycle)
    db.prepare("DELETE FROM graph_state WHERE key = 'research_queue'").run();

    return {
      task: '25-autonomous-research',
      status: 'success',
      duration_seconds: (Date.now() - start) / 1000,
      output: {
        questions_researched: findings.length,
        total_in_queue: queue.length,
        findings: findings.map(f => ({
          question: f.question.slice(0, 80),
          confidence: f.confidence,
          impact: f.impact.slice(0, 100),
        })),
      },
    };
  } catch (err: any) {
    return { task: '25-autonomous-research', status: 'failed', duration_seconds: (Date.now() - start) / 1000, error: err.message };
  }
}
