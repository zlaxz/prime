import type Database from 'better-sqlite3';
import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { generateWorldModel } from './ai/world.js';

// ============================================================
// Interactive Briefing Document Generator
// Produces an HTML file with clickable links to sources,
// Gmail threads, Claude conversations, and action items.
// Opens in browser as a persistent reference alongside Cowork.
// ============================================================

const BRIEFING_DIR = join(homedir(), '.prime', 'briefings');

export function generateBriefingDoc(db: Database.Database): string {
  if (!existsSync(BRIEFING_DIR)) mkdirSync(BRIEFING_DIR, { recursive: true });

  const model = generateWorldModel(db);
  const dateStr = new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
  const timeStr = new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });

  // Build alerts with links
  const alertRows = model.alerts.slice(0, 25).map((a, i) => {
    let link = '';
    if (a.item_id) {
      // Try to find conversation UUID or thread ID for linking
      const item = db.prepare('SELECT source_ref, metadata FROM knowledge WHERE id = ?').get(a.item_id) as any;
      if (item) {
        const meta = typeof item.metadata === 'string' ? JSON.parse(item.metadata) : (item.metadata || {});
        if (meta.conversation_uuid) {
          link = `https://claude.ai/chat/${meta.conversation_uuid}`;
        } else if (meta.thread_id) {
          link = `https://mail.google.com/mail/u/0/#inbox/${meta.thread_id}`;
        } else if (item.source_ref?.startsWith('thread:')) {
          link = `https://mail.google.com/mail/u/0/#inbox/${item.source_ref.replace('thread:', '')}`;
        }
      }
    }

    const sevClass = a.severity === 'critical' ? 'critical' : a.severity === 'high' ? 'high' : 'normal';
    const linkHtml = link ? `<a href="${link}" target="_blank" class="source-link">Open →</a>` : '';
    const num = i + 1;

    return `<tr class="alert-row ${sevClass}">
      <td class="num">${num}</td>
      <td class="alert-title">${escHtml(a.title)}</td>
      <td class="alert-detail">${escHtml(a.detail)}</td>
      <td class="actions">${linkHtml}</td>
    </tr>`;
  }).join('\n');

  // Build people with links
  const peopleRows = model.people.slice(0, 15).map(p => {
    const statusClass = p.status === 'active' ? 'active' : p.status === 'warm' ? 'warm' : p.status === 'cooling' ? 'cooling' : 'cold';
    const label = p.user_label || p.relationship_type || '';
    const commitHtml = p.commitments.length > 0
      ? p.commitments.map(c => `<span class="commitment">${escHtml(c.text)} [${c.state}]</span>`).join('')
      : '';

    return `<tr>
      <td><span class="status-dot ${statusClass}"></span> ${escHtml(p.name)}</td>
      <td>${label}</td>
      <td>${p.mention_count}</td>
      <td>${p.days_since}d</td>
      <td>${p.projects.slice(0, 3).join(', ')}</td>
      <td>${commitHtml}</td>
    </tr>`;
  }).join('\n');

  // Build projects
  const projectRows = model.projects.slice(0, 10).map(p => {
    const staleClass = p.stale ? 'stale' : '';
    return `<tr class="${staleClass}">
      <td>${escHtml(p.name)}</td>
      <td>${p.item_count}</td>
      <td>${p.days_since}d</td>
      <td>${p.people.slice(0, 3).map(pp => pp.name).join(', ')}</td>
      <td>${p.commitments.length > 0 ? p.commitments.map(c => `${c.text} [${c.state}]`).join('<br>') : '—'}</td>
    </tr>`;
  }).join('\n');

  const html = `<!DOCTYPE html>
<html>
<head>
  <title>Prime Recall — ${dateStr}</title>
  <meta charset="utf-8">
  <meta http-equiv="refresh" content="300">
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, system-ui, sans-serif; background: #0a0a1a; color: #e0e0e0; padding: 24px; max-width: 1200px; margin: 0 auto; }
    h1 { font-size: 22px; margin-bottom: 4px; color: #fff; }
    h2 { font-size: 16px; color: #888; text-transform: uppercase; letter-spacing: 1px; margin: 24px 0 12px; border-bottom: 1px solid #222; padding-bottom: 8px; }
    .subtitle { color: #666; font-size: 13px; margin-bottom: 20px; }
    .stats { display: flex; gap: 12px; margin-bottom: 20px; }
    .stat { background: #111; border: 1px solid #222; border-radius: 6px; padding: 12px 16px; text-align: center; flex: 1; }
    .stat .num { font-size: 28px; font-weight: bold; color: #fff; }
    .stat .label { font-size: 11px; color: #888; }
    table { width: 100%; border-collapse: collapse; font-size: 13px; }
    th { text-align: left; color: #888; font-weight: 500; padding: 8px; border-bottom: 1px solid #333; }
    td { padding: 8px; border-bottom: 1px solid #1a1a2a; vertical-align: top; }
    tr:hover { background: #111; }
    .alert-row.critical { border-left: 3px solid #ef4444; }
    .alert-row.high { border-left: 3px solid #f97316; }
    .alert-row.normal { border-left: 3px solid #3b82f6; }
    .num { color: #666; width: 30px; }
    .alert-title { font-weight: 500; color: #fff; }
    .alert-detail { color: #999; }
    .source-link { color: #60a5fa; text-decoration: none; font-size: 12px; white-space: nowrap; }
    .source-link:hover { text-decoration: underline; }
    .status-dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 6px; }
    .status-dot.active { background: #4ade80; }
    .status-dot.warm { background: #facc15; }
    .status-dot.cooling { background: #f97316; }
    .status-dot.cold { background: #ef4444; }
    .commitment { display: block; font-size: 11px; color: #f97316; margin-top: 2px; }
    .stale td { opacity: 0.5; }
    .response-box { background: #111; border: 1px solid #333; border-radius: 8px; padding: 16px; margin-top: 24px; }
    .response-box h3 { font-size: 14px; color: #60a5fa; margin-bottom: 8px; }
    .response-box code { background: #1a1a2a; padding: 2px 6px; border-radius: 3px; font-size: 12px; }
    .response-box p { font-size: 13px; color: #999; line-height: 1.6; }
  </style>
</head>
<body>
  <h1>Prime Recall Briefing</h1>
  <p class="subtitle">${dateStr} at ${timeStr} · ${model.stats.items} items · ${model.stats.entities} entities · Auto-refreshes every 5 min</p>

  <div class="stats">
    <div class="stat"><div class="num">${model.alerts.length}</div><div class="label">Alerts</div></div>
    <div class="stat"><div class="num">${model.people.length}</div><div class="label">Active People</div></div>
    <div class="stat"><div class="num">${model.projects.length}</div><div class="label">Projects</div></div>
    <div class="stat"><div class="num">${model.stats.facts}</div><div class="label">Facts</div></div>
  </div>

  <h2>Needs Attention (respond by number in Cowork)</h2>
  <table>
    <thead><tr><th>#</th><th>Who</th><th>What</th><th>Source</th></tr></thead>
    <tbody>${alertRows}</tbody>
  </table>

  <h2>People</h2>
  <table>
    <thead><tr><th>Name</th><th>Role</th><th>Mentions</th><th>Last Seen</th><th>Projects</th><th>Commitments</th></tr></thead>
    <tbody>${peopleRows}</tbody>
  </table>

  <h2>Projects</h2>
  <table>
    <thead><tr><th>Project</th><th>Items</th><th>Last Activity</th><th>Key People</th><th>Commitments</th></tr></thead>
    <tbody>${projectRows}</tbody>
  </table>

  <div class="response-box">
    <h3>How to Respond</h3>
    <p>Open Claude Desktop Cowork and respond to your COS:</p>
    <p><code>approve 1, dismiss 5, defer 3 to Monday</code></p>
    <p><code>call 2, draft email for 4, skip 6-10</code></p>
    <p>Your responses are saved to Prime Recall and the COS acts on them next run.</p>
  </div>
</body>
</html>`;

  const filePath = join(BRIEFING_DIR, 'latest.html');
  writeFileSync(filePath, html);

  return filePath;
}

function escHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
