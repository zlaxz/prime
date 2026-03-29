import express from 'express';
import { readdirSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { getDb, searchByText, searchByEmbedding, insertKnowledge, getStats, getConfig, type KnowledgeItem } from '../db.js';
import { generateEmbedding } from '../embedding.js';
import { extractIntelligence } from '../ai/extract.js';
import { askWithSources } from '../ai/ask.js';
import { v4 as uuid } from 'uuid';
import { processOtterMeeting } from '../connectors/otter.js';
import { startScheduler } from '../scheduler.js';
import { registerPrimeTools, MCP_SERVER_CONFIG } from './mcp.js';
import { getAmbientDisplayHTML } from './ambient-display.js';

export async function startServer(port: number = 3210, options: { sync?: boolean; syncInterval?: number } = {}) {
  const app = express();
  app.use(express.json({ limit: '10mb' }));

  // CORS for any client
  app.use((_req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    if (_req.method === 'OPTIONS') return res.sendStatus(200);
    next();
  });

  const db = getDb();

  // Health check
  app.get('/api/health', (_req, res) => {
    res.json({ status: 'ok', version: '0.1.0' });
  });

  // Status
  app.get('/api/status', (_req, res) => {
    const stats = getStats(db);
    res.json(stats);
  });

  // Search
  app.post('/api/search', async (req, res) => {
    try {
      const { query, limit = 10, filters = {} } = req.body;
      if (!query) return res.status(400).json({ error: 'query required' });

      const apiKey = getConfig(db, 'openai_api_key');
      let results: any[];

      if (apiKey) {
        try {
          const queryEmb = await generateEmbedding(query, apiKey);
          results = searchByEmbedding(db, queryEmb, limit, 0.3);
        } catch {
          results = searchByText(db, query, limit);
        }
      } else {
        results = searchByText(db, query, limit);
      }

      // Apply filters
      if (filters.source) results = results.filter(r => r.source === filters.source);
      if (filters.project) results = results.filter(r => r.project?.toLowerCase().includes(filters.project.toLowerCase()));
      if (filters.importance) results = results.filter(r => r.importance === filters.importance);

      res.json({ results, count: results.length });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Ask (search + LLM reasoning)
  app.post('/api/ask', async (req, res) => {
    try {
      const { question, model } = req.body;
      if (!question) return res.status(400).json({ error: 'question required' });

      const result = await askWithSources(db, question, { model });
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Ingest
  app.post('/api/ingest', async (req, res) => {
    try {
      const { items } = req.body;
      if (!items || !Array.isArray(items)) return res.status(400).json({ error: 'items array required' });

      const apiKey = getConfig(db, 'openai_api_key');
      if (!apiKey) return res.status(500).json({ error: 'No API key configured' });

      let ingested = 0;

      for (const raw of items) {
        const content = raw.content || raw.text || '';
        const extracted = raw.title && raw.summary ? raw : await extractIntelligence(content, apiKey);

        const embText = `${extracted.title}\n${extracted.summary}`;
        const embedding = await generateEmbedding(embText, apiKey);

        const item: KnowledgeItem = {
          id: raw.id || uuid(),
          title: extracted.title,
          summary: extracted.summary,
          source: raw.source || 'api',
          source_ref: raw.source_ref || `api:${Date.now()}`,
          source_date: raw.source_date,
          contacts: extracted.contacts || raw.contacts || [],
          organizations: extracted.organizations || raw.organizations || [],
          decisions: extracted.decisions || raw.decisions || [],
          commitments: extracted.commitments || raw.commitments || [],
          action_items: extracted.action_items || raw.action_items || [],
          tags: extracted.tags || raw.tags || [],
          project: raw.project || extracted.project,
          importance: raw.importance || extracted.importance || 'normal',
          embedding,
          metadata: raw.metadata,
        };

        insertKnowledge(db, item);
        ingested++;
      }

      res.json({ ingested, total: getStats(db).total_items });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Remember (quick capture)
  app.post('/api/remember', async (req, res) => {
    try {
      const { text, type, project } = req.body;
      if (!text) return res.status(400).json({ error: 'text required' });

      const apiKey = getConfig(db, 'openai_api_key');
      if (!apiKey) return res.status(500).json({ error: 'No API key configured' });

      const extracted = await extractIntelligence(text, apiKey);
      const embText = `${extracted.title}\n${extracted.summary}\n${text}`;
      const embedding = await generateEmbedding(embText, apiKey);

      const item: KnowledgeItem = {
        id: uuid(),
        title: extracted.title,
        summary: extracted.summary,
        source: 'manual',
        source_ref: `manual:${Date.now()}`,
        source_date: new Date().toISOString(),
        contacts: extracted.contacts,
        organizations: extracted.organizations,
        decisions: extracted.decisions,
        commitments: extracted.commitments,
        action_items: extracted.action_items,
        tags: extracted.tags,
        project: project || extracted.project,
        importance: extracted.importance,
        embedding,
      };

      insertKnowledge(db, item);
      res.json({ id: item.id, title: item.title });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Webhooks
  app.post('/api/webhooks/otter', async (req, res) => {
    try {
      const result = await processOtterMeeting(db, req.body);
      res.json({ ok: true, ...result });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Retrieve full source content — "go to the shelf"
  app.post('/api/retrieve', async (req, res) => {
    try {
      const { source_ref } = req.body;
      if (!source_ref) {
        res.status(400).json({ error: 'source_ref required' });
        return;
      }
      // Look up the knowledge item to get source + metadata
      const item = db.prepare('SELECT source, source_ref, metadata FROM knowledge WHERE source_ref = ?').get(source_ref) as any;
      if (!item) {
        res.json({ content: null, error: `No knowledge item found for source_ref: ${source_ref}` });
        return;
      }
      const { retrieveSourceContent } = await import('../source-retrieval.js');
      const result = await retrieveSourceContent(db, {
        source: item.source,
        source_ref: item.source_ref,
        metadata: typeof item.metadata === 'string' ? JSON.parse(item.metadata) : item.metadata,
      });
      if (result) {
        res.json({ content: result.content, content_type: result.content_type, source: result.source });
      } else {
        res.json({ content: null, error: 'Could not retrieve source content' });
      }
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Query endpoints
  app.get('/api/query/contacts', (_req, res) => {
    const results = searchByText(db, '', 1000);
    const contacts = new Map<string, { name: string; count: number; sources: string[] }>();

    for (const item of results) {
      const itemContacts = Array.isArray(item.contacts) ? item.contacts : JSON.parse(item.contacts || '[]');
      for (const name of itemContacts) {
        const existing = contacts.get(name) || { name, count: 0, sources: [] as string[] };
        existing.count++;
        if (!existing.sources.includes(item.source as string)) existing.sources.push(item.source as string);
        contacts.set(name, existing);
      }
    }

    res.json({
      contacts: Array.from(contacts.values()).sort((a, b) => b.count - a.count),
    });
  });

  app.get('/api/query/commitments', (_req, res) => {
    const results = searchByText(db, '', 1000);
    const commitments: any[] = [];

    for (const item of results) {
      const itemCommitments = Array.isArray(item.commitments) ? item.commitments : JSON.parse(item.commitments || '[]');
      for (const c of itemCommitments) {
        commitments.push({
          text: c,
          source: item.source,
          source_ref: item.source_ref,
          date: item.source_date,
          project: item.project,
        });
      }
    }

    res.json({ commitments });
  });

  app.get('/api/query/projects', (_req, res) => {
    const results = searchByText(db, '', 1000);
    const projects = new Map<string, { name: string; items: number; importance: string }>();

    for (const item of results) {
      if (item.project) {
        const existing = projects.get(item.project) || { name: item.project, items: 0, importance: 'normal' };
        existing.items++;
        if (item.importance === 'critical' || (item.importance === 'high' && existing.importance !== 'critical')) {
          existing.importance = item.importance;
        }
        projects.set(item.project, existing);
      }
    }

    res.json({
      projects: Array.from(projects.values()).sort((a, b) => b.items - a.items),
    });
  });

  // ── Ambient State API (powers all display surfaces) ─────
  app.get('/api/ambient', (_req, res) => {
    try {
      // ============================================================
      // PRIORITY ENGINE — Business-driven, not reply-driven
      //
      // Tier 1: Strategic milestones (deadlines, launches, obligations)
      // Tier 2: Active deal work (what moves deals forward)
      // Tier 3: Genuine dropped balls (filtered — no solicitations)
      // ============================================================

      const priorities: any[] = [];

      // ---- TIER 1: Strategic milestones ----
      // Overdue and upcoming commitments with due dates
      const urgentCommitments = db.prepare(`
        SELECT id, text, state, due_date, owner, project, context
        FROM commitments
        WHERE state IN ('active', 'overdue')
        AND due_date IS NOT NULL
        AND due_date < datetime('now', '+7 days')
        ORDER BY due_date ASC
        LIMIT 5
      `).all() as any[];

      for (const c of urgentCommitments) {
        const daysUntil = Math.round((new Date(c.due_date).getTime() - Date.now()) / 86400000);
        const isOverdue = daysUntil < 0;
        priorities.push({
          id: `commitment-${c.id}`,
          tier: 1,
          type: 'milestone',
          summary: c.text,
          reasoning: isOverdue
            ? `${Math.abs(daysUntil)} days overdue. ${c.context || ''}`
            : `Due in ${daysUntil} day${daysUntil !== 1 ? 's' : ''}. ${c.context || ''}`,
          project: c.project,
          urgency: isOverdue ? 'critical' : daysUntil <= 2 ? 'high' : 'medium',
          due_date: c.due_date,
        });
      }

      // Project profiles — accelerating projects need next actions surfaced
      let projectProfiles: any[] = [];
      try {
        const profilesRaw = db.prepare("SELECT value FROM graph_state WHERE key = 'project_profiles'").get() as any;
        if (profilesRaw) projectProfiles = JSON.parse(profilesRaw.value);
      } catch {}

      // Surface ALL projects with next actions — the system already figured out what matters
      const statusUrgency: Record<string, string> = {
        accelerating: 'critical',  // Carefront launch — highest urgency
        stalling: 'high',          // Stalling deals need unblocking
        active: 'medium',
        steady: 'low',
      };

      // Skip projects that are just maintenance or have been paused
      const skipProjects = new Set(['COI Processing Automation', 'Prime']);

      for (const p of projectProfiles) {
        if (!p.next_action) continue;
        if (skipProjects.has(p.project)) continue;
        if (p.next_action.toLowerCase().includes('no action needed')) continue;

        // Don't duplicate if project already in commitments
        const alreadyShown = priorities.some(pr => pr.project === p.project && pr.tier === 1);

        priorities.push({
          id: `project-${p.project}`,
          tier: alreadyShown ? 2 : 1, // Demote to tier 2 if commitment already covers it
          type: 'strategic',
          summary: p.next_action,
          reasoning: `${p.project} [${p.status}]: ${p.status_reasoning?.slice(0, 150)}`,
          project: p.project,
          urgency: statusUrgency[p.status] || 'medium',
        });
      }

      // ---- TIER 2: Staged actions (quality-gated) ----
      const rawActions = db.prepare(
        "SELECT id, type, summary, reasoning, project, payload, created_at FROM staged_actions WHERE status = 'pending' AND (expires_at IS NULL OR expires_at > datetime('now')) ORDER BY id"
      ).all() as any[];

      for (const a of rawActions) {
        let payload: any = {};
        try { payload = typeof a.payload === 'string' ? JSON.parse(a.payload) : (a.payload || {}); } catch {}

        // QUALITY GATE: Skip actions targeting dismissed/noise entities
        if (payload.to) {
          const isDismissed = db.prepare(
            "SELECT 1 FROM entities WHERE (email = ? OR canonical_name LIKE ?) AND user_dismissed = 1"
          ).get(payload.to, `%${payload.to.split('@')[0]}%`);
          if (isDismissed) continue;

          // QUALITY GATE: Skip if there's been new communication since action was created
          // (action may be stale)
          const newActivity = db.prepare(`
            SELECT COUNT(*) as cnt FROM knowledge
            WHERE source_date > ? AND (contacts LIKE ? OR summary LIKE ?)
          `).get(a.created_at, `%${payload.to}%`, `%${payload.to.split('@')[0]}%`) as any;

          if (newActivity?.cnt > 0) {
            // Mark as stale but don't skip entirely — show with warning
            a._stale = true;
          }
        }

        // QUALITY GATE: Skip actions older than 72 hours
        const ageHours = (Date.now() - new Date(a.created_at).getTime()) / 3600000;
        if (ageHours > 72) {
          db.prepare("UPDATE staged_actions SET status = 'expired' WHERE id = ?").run(a.id);
          continue;
        }

        priorities.push({
          id: `action-${a.id}`,
          tier: 2,
          type: a.type || 'task',
          summary: a.summary,
          reasoning: a.reasoning,
          project: a.project,
          urgency: 'medium',
          to: payload.to || null,
          subject: payload.subject || null,
          body: payload.body || null,
          gmail_link: payload.to ? `https://mail.google.com/mail/?view=cm&to=${encodeURIComponent(payload.to)}&su=${encodeURIComponent(payload.subject || '')}&body=${encodeURIComponent(payload.body || '')}` : null,
          stale: a._stale || false,
          action_id: a.id, // for approve/dismiss
        });
      }

      // ---- TIER 3: Entity alerts (genuine concerns only) ----
      try {
        const entityAlerts = db.prepare(`
          SELECT e.canonical_name, e.user_label, ep.alert_verdict, ep.communication_nature
          FROM entity_profiles ep
          JOIN entities e ON ep.entity_id = e.id
          WHERE ep.alert_verdict = 'genuine_concern'
          AND e.user_dismissed = 0
          AND e.user_label NOT IN ('noise', 'solicitation')
          ORDER BY ep.last_verified_at DESC LIMIT 3
        `).all() as any[];

        for (const ea of entityAlerts) {
          priorities.push({
            id: `entity-${ea.canonical_name}`,
            tier: 3,
            type: 'relationship',
            summary: `${ea.canonical_name} — ${ea.communication_nature || 'needs attention'}`,
            reasoning: `Relationship type: ${ea.user_label || 'unknown'}. Alert: ${ea.alert_verdict}`,
            urgency: 'low',
          });
        }
      } catch {}

      // Sort: Tier 1 first, then by urgency within tier
      const urgencyOrder: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };
      priorities.sort((a, b) => {
        if (a.tier !== b.tier) return a.tier - b.tier;
        return (urgencyOrder[a.urgency] || 3) - (urgencyOrder[b.urgency] || 3);
      });

      // ---- THE ONE THING ----
      // Highest priority = The One Thing
      let oneThing = 'No urgent priorities. Focus on what matters most to you.';
      if (priorities.length > 0) {
        const top = priorities[0];
        oneThing = top.summary;
        if (top.due_date) {
          const daysUntil = Math.round((new Date(top.due_date).getTime() - Date.now()) / 86400000);
          if (daysUntil < 0) oneThing += ` — ${Math.abs(daysUntil)} days overdue`;
          else if (daysUntil === 0) oneThing += ' — due today';
          else oneThing += ` — due in ${daysUntil} days`;
        }
      }

      // ---- CONTEXT ----
      const narrativeState = db.prepare("SELECT value, updated_at FROM graph_state WHERE key = 'world_narrative'").get() as any;
      const narrativeAge = narrativeState ? (Date.now() - new Date(narrativeState.updated_at).getTime()) / 3600000 : 999;

      const predAccuracy = db.prepare("SELECT value FROM graph_state WHERE key = 'prediction_accuracy'").get() as any;
      const accuracy = predAccuracy ? JSON.parse(predAccuracy.value) : null;

      const threads = db.prepare(
        "SELECT title, current_state, next_action, project, source_count, item_count FROM narrative_threads WHERE status = 'active' ORDER BY latest_source_date DESC LIMIT 5"
      ).all() as any[];

      const reflection = db.prepare("SELECT value FROM graph_state WHERE key = 'strategic_reflection_latest'").get() as any;
      const metaInsight = reflection ? JSON.parse(reflection.value)?.meta_insight : null;

      const lastDream = (db.prepare("SELECT value FROM graph_state WHERE key = 'last_dream_run'").get() as any)?.value;
      const dreamAge = lastDream ? (Date.now() - new Date(lastDream).getTime()) / 3600000 : 999;

      const todayStart = new Date(); todayStart.setHours(0,0,0,0);
      const todayEnd = new Date(); todayEnd.setHours(23,59,59,999);
      const todayEvents = db.prepare(`
        SELECT title, source_date, metadata FROM knowledge_primary
        WHERE source = 'calendar' AND source_date >= ? AND source_date <= ?
        ORDER BY source_date ASC LIMIT 5
      `).all(todayStart.toISOString(), todayEnd.toISOString()) as any[];

      const stats = getStats(db);

      // Display state based on priority tiers
      const hasCritical = priorities.some(p => p.urgency === 'critical');
      const hasActions = priorities.some(p => p.tier === 2);
      let displayState = 'ambient';
      if (hasCritical) displayState = 'crisis';
      else if (hasActions || priorities.length > 3) displayState = 'pulse';
      else if (narrativeAge < 1) displayState = 'briefing';

      res.json({
        display_state: displayState,
        one_thing: oneThing,
        actions_pending: priorities.length,
        actions: priorities.slice(0, 8), // Max 8 displayed
        threads: threads.map((t: any) => ({ title: t.title, state: t.current_state, next: t.next_action, items: t.item_count })),
        calendar_today: todayEvents.map((e: any) => {
          const meta = typeof e.metadata === 'string' ? JSON.parse(e.metadata) : e.metadata || {};
          return { title: e.title, time: meta.start_time || e.source_date };
        }),
        prediction_accuracy: accuracy ? Math.round(accuracy.accuracy_rate * 100) : null,
        meta_insight: metaInsight,
        dream_age_hours: Math.round(dreamAge),
        knowledge_items: stats.total_items,
        timestamp: new Date().toISOString(),
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Chat API (replaces Claude Desktop as primary interface) ──
  app.get('/api/v1/chat/sidebar', async (_req, res) => {
    try {
      const { getChatSidebar } = await import('../ai/chat.js');
      res.json(getChatSidebar(db));
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  app.get('/api/v1/chat/sessions', (req, res) => {
    try {
      const project = req.query.project as string | undefined;
      const query = project
        ? "SELECT * FROM chat_sessions WHERE status = 'active' AND primary_project = ? ORDER BY updated_at DESC LIMIT 50"
        : "SELECT * FROM chat_sessions WHERE status = 'active' ORDER BY updated_at DESC LIMIT 50";
      const sessions = project ? db.prepare(query).all(project) : db.prepare(query).all();
      res.json({ sessions });
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  app.get('/api/v1/chat/sessions/:id', (req, res) => {
    try {
      const session = db.prepare('SELECT * FROM chat_sessions WHERE id = ?').get(req.params.id);
      const messages = db.prepare('SELECT * FROM chat_messages WHERE session_id = ? ORDER BY created_at ASC').all(req.params.id);
      res.json({ session, messages });
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  app.post('/api/v1/chat/message', async (req, res) => {
    try {
      const { chatMessage } = await import('../ai/chat.js');
      const { session_id, message, project, thread_id } = req.body;
      if (!message) { res.status(400).json({ error: 'message required' }); return; }
      const result = await chatMessage(db, { session_id, message, project, thread_id });
      res.json(result);
    } catch (err: any) {
      console.error('[Chat] Error:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  app.delete('/api/v1/chat/sessions/:id', (req, res) => {
    try {
      db.prepare("UPDATE chat_sessions SET status = 'archived' WHERE id = ?").run(req.params.id);
      res.json({ ok: true });
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  // ── Action approval (for ambient display + API clients) ──
  app.post('/api/approve-action', async (req, res) => {
    try {
      const { id } = req.body;
      if (!id) return res.status(400).json({ error: 'id required' });
      const { executeAction } = await import('../actions.js');
      const result = await executeAction(db, id);
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Ambient Display (full-screen kiosk app) ────────────
  app.get('/ambient', (_req, res) => {
    res.send(getAmbientDisplayHTML());
  });

  // ── Legacy Dashboard ───────────────────────────────────
  app.get('/dashboard', async (_req, res) => {
    const stats = getStats(db);

    // Get agent reports
    const agentReports = db.prepare(
      "SELECT * FROM knowledge WHERE source = 'agent-report' ORDER BY source_date DESC LIMIT 10"
    ).all() as any[];

    // Get alerts
    const alertItems = db.prepare(
      "SELECT * FROM knowledge WHERE source = 'agent-notification' ORDER BY source_date DESC LIMIT 10"
    ).all() as any[];

    // Get team config
    const agentsDir = join(homedir(), '.prime', 'agents');
    let agents: any[] = [];
    if (existsSync(agentsDir)) {
      agents = readdirSync(agentsDir)
        .filter((f: string) => f.endsWith('.json'))
        .map((f: string) => {
          try { return JSON.parse(readFileSync(join(agentsDir, f), 'utf-8')); } catch { return null; }
        })
        .filter(Boolean);
    }

    const formatAge = (dateStr: string) => {
      if (!dateStr) return 'never';
      const h = Math.floor((Date.now() - new Date(dateStr).getTime()) / 3600000);
      if (h < 1) return 'just now';
      if (h < 24) return `${h}h ago`;
      return `${Math.floor(h / 24)}d ago`;
    };

    const reportCards = agentReports.map(r => {
      const meta = typeof r.metadata === 'string' ? JSON.parse(r.metadata) : (r.metadata || {});
      const fullReport = (meta.full_report || r.summary || '').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      return `
        <div class="card">
          <div class="card-header">
            <span class="badge">${meta.agent || '?'}</span>
            <span class="age">${formatAge(r.source_date)}</span>
          </div>
          <h3>${(r.title || '').replace(/</g, '&lt;')}</h3>
          <pre class="report">${fullReport}</pre>
        </div>`;
    }).join('');

    const teamCards = agents.map((a: any) => `
      <div class="team-member">
        <span class="status ${a.enabled ? 'active' : 'disabled'}"></span>
        <strong>${a.role}</strong> (${a.name})
        <div class="meta">
          Schedule: ${a.schedule} | Last run: ${formatAge(a.last_run)} | Notify: ${a.notify}+
          ${a.project ? `<br>Project: ${a.project}` : ''}
        </div>
      </div>`).join('');

    const alertCards = alertItems.map(a => {
      const meta = typeof a.metadata === 'string' ? JSON.parse(a.metadata) : (a.metadata || {});
      return `
        <div class="alert-item ${meta.urgency || 'normal'}">
          <strong>${(a.title || '').replace(/</g, '&lt;')}</strong>
          <span class="age">${formatAge(a.source_date)}</span>
        </div>`;
    }).join('') || '<p class="muted">No recent notifications</p>';

    res.send(`<!DOCTYPE html>
<html>
<head>
  <title>Prime Recall — Dashboard</title>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta http-equiv="refresh" content="120">
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, system-ui, sans-serif; background: #0a0a1a; color: #e0e0e0; padding: 20px; }
    h1 { font-size: 24px; margin-bottom: 4px; }
    .subtitle { color: #888; font-size: 14px; margin-bottom: 24px; }
    .grid { display: grid; grid-template-columns: 1fr 320px; gap: 20px; }
    .sidebar { display: flex; flex-direction: column; gap: 16px; }

    .section { margin-bottom: 24px; }
    .section h2 { font-size: 16px; color: #aaa; text-transform: uppercase; letter-spacing: 1px; margin-bottom: 12px; border-bottom: 1px solid #222; padding-bottom: 8px; }

    .stats { display: flex; gap: 16px; margin-bottom: 24px; }
    .stat { background: #111; border: 1px solid #222; border-radius: 8px; padding: 16px; flex: 1; text-align: center; }
    .stat .number { font-size: 32px; font-weight: bold; color: #fff; }
    .stat .label { font-size: 12px; color: #888; margin-top: 4px; }

    .card { background: #111; border: 1px solid #222; border-radius: 8px; padding: 16px; margin-bottom: 12px; }
    .card-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; }
    .card h3 { font-size: 15px; margin-bottom: 8px; color: #fff; }
    .badge { background: #2a2a4a; color: #8888ff; padding: 2px 8px; border-radius: 4px; font-size: 12px; }
    .age { color: #666; font-size: 12px; }
    .report { font-size: 13px; line-height: 1.5; color: #bbb; white-space: pre-wrap; max-height: 400px; overflow-y: auto; }

    .team-member { background: #111; border: 1px solid #222; border-radius: 8px; padding: 12px; margin-bottom: 8px; }
    .team-member .meta { font-size: 12px; color: #666; margin-top: 4px; }
    .status { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 6px; }
    .status.active { background: #4ade80; }
    .status.disabled { background: #666; }

    .alert-item { padding: 8px 12px; border-radius: 6px; margin-bottom: 6px; font-size: 13px; display: flex; justify-content: space-between; }
    .alert-item.critical { background: #2a0a0a; border-left: 3px solid #ef4444; }
    .alert-item.high { background: #2a1a0a; border-left: 3px solid #f97316; }
    .alert-item.normal { background: #0a1a2a; border-left: 3px solid #3b82f6; }
    .muted { color: #555; font-size: 13px; }

    @media (max-width: 768px) { .grid { grid-template-columns: 1fr; } }
  </style>
</head>
<body>
  <h1>Prime Recall</h1>
  <p class="subtitle">${stats.total_items} knowledge items · ${agents.length} agents · Auto-refreshes every 2 min</p>

  <div class="stats">
    <div class="stat"><div class="number">${stats.total_items}</div><div class="label">Knowledge Items</div></div>
    <div class="stat"><div class="number">${agents.length}</div><div class="label">AI Employees</div></div>
    <div class="stat"><div class="number">${agentReports.length}</div><div class="label">Recent Reports</div></div>
    <div class="stat"><div class="number">${alertItems.length}</div><div class="label">Notifications</div></div>
  </div>

  <div class="grid">
    <div class="main">
      <div class="section">
        <h2>Agent Reports</h2>
        ${reportCards || '<p class="muted">No agent reports yet. Run: recall run-agent cos</p>'}
      </div>
    </div>

    <div class="sidebar">
      <div class="section">
        <h2>Your Team</h2>
        ${teamCards || '<p class="muted">No agents hired</p>'}
      </div>

      <div class="section">
        <h2>Notifications</h2>
        ${alertCards}
      </div>

      <div class="section">
        <h2>Sources</h2>
        ${(stats.by_source || []).map((s: any) => `<div style="display:flex;justify-content:space-between;padding:4px 0;font-size:13px;"><span>${s.source}</span><span style="color:#888">${s.count}</span></div>`).join('')}
      </div>
    </div>
  </div>
</body>
</html>`);
  });

  // ── MCP over SSE (for remote Claude Desktop) ───────────
  // GET /mcp establishes SSE stream, POST /mcp/messages sends JSON-RPC
  const mcpTransports = new Map<string, SSEServerTransport>();

  app.get('/mcp', async (req, res) => {
    try {
      const transport = new SSEServerTransport('/mcp/messages', res);
      const sessionId = transport.sessionId;
      mcpTransports.set(sessionId, transport);

      transport.onclose = () => {
        mcpTransports.delete(sessionId);
      };

      const mcpServer = new McpServer(MCP_SERVER_CONFIG);
      registerPrimeTools(mcpServer);
      await mcpServer.connect(transport);

      console.log(`[MCP] SSE session established: ${sessionId}`);
    } catch (error: any) {
      console.error('[MCP] SSE error:', error.message);
      if (!res.headersSent) res.status(500).send('Error establishing SSE stream');
    }
  });

  app.post('/mcp/messages', async (req, res) => {
    const sessionId = req.query.sessionId as string;
    if (!sessionId) {
      res.status(400).send('Missing sessionId parameter');
      return;
    }

    const transport = mcpTransports.get(sessionId);
    if (!transport) {
      res.status(404).send('Session not found');
      return;
    }

    try {
      await transport.handlePostMessage(req, res, req.body);
    } catch (error: any) {
      console.error('[MCP] Message error:', error.message);
      if (!res.headersSent) res.status(500).send('Error handling request');
    }
  });

  // ============================================================
  // Command Dispatch — unified natural language interface
  // ============================================================
  app.post('/api/v1/command', async (req, res) => {
    try {
      const { text } = req.body;
      if (!text) { res.status(400).json({ error: 'text required' }); return; }

      const cmd = text.trim().toLowerCase();

      // Pattern-match commands (instant, no LLM)
      if (cmd === 'status') {
        res.json({ intent: 'status', result: getStats(db) });
        return;
      }

      if (cmd === 'commitments' || cmd.startsWith('commitment')) {
        const rows = db.prepare("SELECT * FROM commitments WHERE state IN ('active','overdue') ORDER BY due_date ASC LIMIT 10").all();
        res.json({ intent: 'commitments', result: rows });
        return;
      }

      if (cmd === 'briefing' || cmd === 'brief') {
        const { askWithSources: ask } = await import('../ai/ask.js');
        const answer = await ask(db, 'Generate a morning briefing: top priorities, commitments due, dropped balls, relationship health.');
        res.json({ intent: 'briefing', result: answer });
        return;
      }

      if (cmd === 'calendar' || cmd === 'today') {
        const rows = db.prepare("SELECT title, summary, source_date, contacts, project FROM knowledge WHERE source = 'calendar' AND source_date >= date('now') AND source_date < date('now', '+2 days') ORDER BY source_date ASC LIMIT 10").all();
        res.json({ intent: 'calendar', result: rows });
        return;
      }

      if (cmd.startsWith('predict ') || cmd.startsWith('prediction ')) {
        const entity = text.replace(/^predict(ion)?\s+/i, '').trim();
        const { getEntityPrediction, ensurePredictorSchema } = await import('../ai/predict.js');
        ensurePredictorSchema(db);
        const pred = getEntityPrediction(db, entity);
        res.json({ intent: 'predict', entity, result: pred });
        return;
      }

      if (cmd.startsWith('search ')) {
        const query = text.replace(/^search\s+/i, '').trim();
        const apiKey = getConfig(db, 'openai_api_key');
        let results: any[];
        if (apiKey) {
          try {
            const emb = await generateEmbedding(query, apiKey);
            results = searchByEmbedding(db, emb, 10, 0.3);
          } catch {
            results = searchByText(db, query, 10);
          }
        } else {
          results = searchByText(db, query, 10);
        }
        res.json({ intent: 'search', query, result: results });
        return;
      }

      if (cmd.startsWith('ask ')) {
        const question = text.replace(/^ask\s+/i, '').trim();
        const { askWithSources: ask } = await import('../ai/ask.js');
        const answer = await ask(db, question);
        res.json({ intent: 'ask', result: answer });
        return;
      }

      if (cmd.startsWith('capture ') || cmd.startsWith('remember ')) {
        const content = text.replace(/^(capture|remember)\s+/i, '').trim();
        const apiKey = getConfig(db, 'openai_api_key');
        const extracted = await extractIntelligence(content, apiKey);
        const emb = await generateEmbedding(`${extracted.title}\n${extracted.summary}`, apiKey!);
        const item: KnowledgeItem = {
          id: uuid(), title: extracted.title, summary: extracted.summary,
          source: 'command', source_ref: `command:${Date.now()}`,
          source_date: new Date().toISOString(),
          contacts: extracted.contacts, organizations: extracted.organizations,
          decisions: extracted.decisions, commitments: extracted.commitments,
          action_items: extracted.action_items, tags: extracted.tags,
          project: extracted.project, importance: extracted.importance, embedding: emb,
        };
        insertKnowledge(db, item);
        res.json({ intent: 'capture', result: { id: item.id, title: item.title } });
        return;
      }

      if (cmd.startsWith('approve ')) {
        const id = text.replace(/^approve\s+/i, '').trim();
        try {
          const { executeAction } = await import('../actions.js');
          const result = await executeAction(db, id);
          res.json({ intent: 'approve', result });
        } catch (err: any) {
          res.json({ intent: 'approve', error: err.message });
        }
        return;
      }

      // Unrecognized — try as a search
      const results = searchByText(db, text, 5);
      if (results.length > 0) {
        res.json({ intent: 'search_fallback', query: text, result: results });
      } else {
        res.json({
          intent: 'unknown',
          preview: `I didn't understand "${text}". Try: search, ask, commitments, predict, capture, approve, briefing, calendar, status`,
          needs_disambiguation: true,
        });
      }
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ============================================================
  // Predictions API
  // ============================================================
  app.get('/api/v1/predictions', async (_req, res) => {
    try {
      const { getAnomalies, ensurePredictorSchema } = await import('../ai/predict.js');
      ensurePredictorSchema(db);
      const anomalies = getAnomalies(db);
      res.json({ anomalies, total: anomalies.length });
    } catch (err: any) {
      res.json({ anomalies: [], total: 0, error: err.message });
    }
  });

  // ============================================================
  // Calendar context API
  // ============================================================
  app.get('/api/v1/calendar', (_req, res) => {
    try {
      const events = db.prepare(`
        SELECT title, summary, source_date, contacts, project, metadata
        FROM knowledge
        WHERE source = 'calendar'
        AND source_date >= datetime('now', '-1 hour')
        AND source_date < datetime('now', '+2 days')
        ORDER BY source_date ASC
        LIMIT 10
      `).all();

      // Parse JSON fields
      for (const e of events as any[]) {
        for (const f of ['contacts', 'metadata']) {
          if (e[f] && typeof e[f] === 'string') {
            try { e[f] = JSON.parse(e[f]); } catch {}
          }
        }
      }

      res.json({ events, count: events.length });
    } catch (err: any) {
      res.json({ events: [], count: 0, error: err.message });
    }
  });

  app.listen(port, '0.0.0.0', () => {
    const stats = getStats(db);
    console.log(`\n⚡ Prime server running on http://0.0.0.0:${port}`);
    console.log(`  Knowledge base: ${stats.total_items} items\n`);
    console.log('  Endpoints:');
    console.log('    POST /api/search    — Semantic search');
    console.log('    POST /api/ask       — AI conversation');
    console.log('    POST /api/ingest    — Add knowledge');
    console.log('    POST /api/remember  — Quick capture');
    console.log('    GET  /api/status    — Knowledge base stats');
    console.log('    GET  /api/query/*   — Structured queries');
    console.log('    ALL  /mcp           — MCP over HTTP (for remote Claude Desktop)');
    console.log('    POST /api/webhooks/otter — Otter.ai webhook\n');

    if (options.sync !== false) {
      startScheduler(options.syncInterval || 15);
    }
  });
}
