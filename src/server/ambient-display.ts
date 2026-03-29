// ============================================================
// Prime Ambient Display — The Jarvis Interface
//
// Full-screen kiosk app for wall-mounted TV / dedicated monitor.
// Served as self-contained HTML from /ambient endpoint.
// Polls /api/ambient every 30s for state updates.
// Five display modes: ambient, pulse, focus, briefing, crisis
// Arc Reactor inspired dark theme.
// ============================================================

export function getAmbientDisplayHTML(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black">
<title>PRIME</title>
<style>
  @import url('https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&display=swap');

  :root {
    --bg: #050510;
    --surface: #0a0a1a;
    --border: #1a1a2e;
    --text: #e0e0e8;
    --text-dim: #666680;
    --accent: #4a9eff;
    --accent-glow: rgba(74, 158, 255, 0.15);
    --success: #4ade80;
    --warning: #f59e0b;
    --danger: #ef4444;
    --danger-glow: rgba(239, 68, 68, 0.15);
  }

  * { margin: 0; padding: 0; box-sizing: border-box; }

  body {
    font-family: 'Inter', -apple-system, sans-serif;
    background: var(--bg);
    color: var(--text);
    height: 100vh;
    width: 100vw;
    overflow: hidden;
    cursor: none;
    user-select: none;
  }

  body.interactive { cursor: default; }

  /* ── AMBIENT STATE ────────────────────────── */
  #ambient {
    display: flex;
    flex-direction: column;
    justify-content: center;
    align-items: center;
    height: 100vh;
    transition: opacity 0.8s ease;
  }

  .reactor-ring {
    width: 200px;
    height: 200px;
    border-radius: 50%;
    border: 2px solid var(--border);
    display: flex;
    align-items: center;
    justify-content: center;
    position: relative;
    margin-bottom: 48px;
  }

  .reactor-ring::before {
    content: '';
    position: absolute;
    width: 100%;
    height: 100%;
    border-radius: 50%;
    border: 1px solid var(--accent);
    opacity: 0.3;
    animation: pulse-ring 4s ease-in-out infinite;
  }

  @keyframes pulse-ring {
    0%, 100% { transform: scale(1); opacity: 0.2; }
    50% { transform: scale(1.08); opacity: 0.4; }
  }

  .reactor-count {
    font-size: 72px;
    font-weight: 300;
    letter-spacing: -2px;
  }

  .reactor-count.green { color: var(--success); }
  .reactor-count.yellow { color: var(--warning); }
  .reactor-count.red { color: var(--danger); }

  .reactor-ring.red { border-color: var(--danger); }
  .reactor-ring.red::before { border-color: var(--danger); animation-name: pulse-ring-danger; }
  @keyframes pulse-ring-danger {
    0%, 100% { transform: scale(1); opacity: 0.3; }
    50% { transform: scale(1.12); opacity: 0.6; }
  }

  .ambient-line {
    font-size: 18px;
    font-weight: 300;
    color: var(--text-dim);
    text-align: center;
    max-width: 600px;
    line-height: 1.6;
  }

  .ambient-time {
    position: absolute;
    top: 32px;
    left: 40px;
    font-size: 14px;
    font-weight: 300;
    color: var(--text-dim);
    opacity: 0.5;
  }

  .ambient-meta {
    position: absolute;
    bottom: 32px;
    right: 40px;
    font-size: 12px;
    color: var(--text-dim);
    opacity: 0.3;
    text-align: right;
  }

  /* ── PULSE STATE (card slides up) ─────────── */
  .pulse-card {
    position: fixed;
    bottom: -200px;
    left: 50%;
    transform: translateX(-50%);
    width: min(90vw, 600px);
    background: var(--surface);
    border: 1px solid var(--accent);
    border-radius: 16px;
    padding: 24px 32px;
    box-shadow: 0 -4px 40px var(--accent-glow);
    transition: bottom 0.6s cubic-bezier(0.16, 1, 0.3, 1);
    z-index: 100;
  }

  .pulse-card.visible { bottom: 40px; }

  .pulse-card .card-type {
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 2px;
    color: var(--accent);
    margin-bottom: 8px;
  }

  .pulse-card .card-title {
    font-size: 20px;
    font-weight: 500;
    margin-bottom: 8px;
  }

  .pulse-card .card-project {
    font-size: 13px;
    color: var(--text-dim);
  }

  .pulse-card .card-actions {
    display: flex;
    gap: 12px;
    margin-top: 20px;
  }

  .btn {
    padding: 12px 32px;
    border-radius: 8px;
    font-size: 15px;
    font-weight: 500;
    border: none;
    cursor: pointer;
    transition: all 0.2s;
  }

  .btn-primary {
    background: var(--accent);
    color: white;
  }
  .btn-primary:hover { filter: brightness(1.2); }

  .btn-ghost {
    background: transparent;
    color: var(--text-dim);
    border: 1px solid var(--border);
  }
  .btn-ghost:hover { border-color: var(--text-dim); }

  /* ── CRISIS STATE ────────────────────────── */
  .crisis-overlay {
    position: fixed;
    inset: 0;
    background: var(--danger-glow);
    display: none;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    z-index: 200;
    animation: crisis-pulse 2s ease-in-out infinite;
  }

  .crisis-overlay.active { display: flex; }

  @keyframes crisis-pulse {
    0%, 100% { background: rgba(239, 68, 68, 0.05); }
    50% { background: rgba(239, 68, 68, 0.12); }
  }

  .crisis-title {
    font-size: 28px;
    font-weight: 600;
    color: var(--danger);
    margin-bottom: 16px;
    text-align: center;
  }

  .crisis-detail {
    font-size: 18px;
    color: var(--text);
    text-align: center;
    max-width: 500px;
    margin-bottom: 32px;
  }

  /* ── THREAD STRIP (bottom of ambient) ─────── */
  .thread-strip {
    position: absolute;
    bottom: 80px;
    left: 40px;
    right: 40px;
    display: flex;
    gap: 16px;
    overflow-x: auto;
    opacity: 0.4;
    transition: opacity 0.3s;
  }

  .thread-strip:hover { opacity: 0.8; }

  .thread-chip {
    flex-shrink: 0;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 8px 16px;
    font-size: 12px;
  }

  .thread-chip .chip-title {
    font-weight: 500;
    color: var(--text);
    margin-bottom: 2px;
  }

  .thread-chip .chip-state {
    color: var(--text-dim);
    font-size: 11px;
  }

  /* ── CALENDAR STRIP (top right) ──────────── */
  .calendar-strip {
    position: absolute;
    top: 32px;
    right: 40px;
    text-align: right;
  }

  .cal-event {
    font-size: 13px;
    color: var(--text-dim);
    margin-bottom: 4px;
  }

  .cal-event .cal-time {
    color: var(--accent);
    font-weight: 500;
  }

  /* ── FADE TRANSITIONS ───────────────────── */
  .fade-enter { opacity: 0; transform: translateY(10px); }
  .fade-active { opacity: 1; transform: translateY(0); transition: all 0.5s ease; }
</style>
</head>
<body>

<div id="ambient">
  <div class="ambient-time" id="clock"></div>

  <div class="calendar-strip" id="calendar"></div>

  <div class="reactor-ring" id="reactor-ring">
    <span class="reactor-count" id="reactor-count">0</span>
  </div>

  <div class="ambient-line" id="ambient-line">Loading...</div>

  <div class="thread-strip" id="threads"></div>

  <div class="ambient-meta" id="meta"></div>
</div>

<div class="pulse-card" id="pulse-card">
  <div class="card-type" id="pulse-type"></div>
  <div class="card-title" id="pulse-title"></div>
  <div class="card-project" id="pulse-project"></div>
  <div class="card-actions">
    <button class="btn btn-primary" id="btn-approve" onclick="approveAction()">Approve</button>
    <button class="btn btn-ghost" onclick="dismissPulse()">Later</button>
  </div>
</div>

<div class="crisis-overlay" id="crisis">
  <div class="crisis-title" id="crisis-title"></div>
  <div class="crisis-detail" id="crisis-detail"></div>
  <button class="btn btn-primary" style="font-size:18px;padding:16px 48px" id="btn-crisis" onclick="approveAction()">Handle It</button>
</div>

<script>
let state = {};
let currentActionId = null;
let pulseTimeout = null;

async function fetchState() {
  try {
    const res = await fetch('/api/ambient');
    state = await res.json();
    render();
  } catch (e) {
    document.getElementById('ambient-line').textContent = 'Connection lost. Retrying...';
  }
}

function render() {
  // Clock
  const now = new Date();
  document.getElementById('clock').textContent =
    now.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' }) +
    ' ' + now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });

  // Reactor count + color
  const count = state.actions_pending || 0;
  const el = document.getElementById('reactor-count');
  const ring = document.getElementById('reactor-ring');
  el.textContent = count;

  el.className = 'reactor-count ' + (count === 0 ? 'green' : count <= 2 ? 'yellow' : 'red');
  ring.className = 'reactor-ring ' + (count >= 3 ? 'red' : '');

  // Ambient line
  document.getElementById('ambient-line').textContent =
    count === 0 ? (state.one_thing || 'All systems nominal. Nothing needs your attention.')
    : state.one_thing || count + ' item' + (count === 1 ? '' : 's') + ' need attention';

  // Calendar
  const calEl = document.getElementById('calendar');
  if (state.calendar_today && state.calendar_today.length > 0) {
    calEl.innerHTML = state.calendar_today.map(e => {
      const t = e.time ? new Date(e.time).toLocaleTimeString('en-US', {hour:'numeric', minute:'2-digit'}) : '';
      return '<div class="cal-event"><span class="cal-time">' + t + '</span> ' + e.title + '</div>';
    }).join('');
  } else {
    calEl.innerHTML = '<div class="cal-event" style="opacity:0.3">No meetings today</div>';
  }

  // Threads
  const threadEl = document.getElementById('threads');
  if (state.threads && state.threads.length > 0) {
    threadEl.innerHTML = state.threads.map(t =>
      '<div class="thread-chip"><div class="chip-title">' + t.title + '</div><div class="chip-state">' + (t.state || '') + '</div></div>'
    ).join('');
  } else {
    threadEl.innerHTML = '';
  }

  // Meta
  const metaParts = [];
  if (state.knowledge_items) metaParts.push(state.knowledge_items + ' knowledge items');
  if (state.prediction_accuracy) metaParts.push(state.prediction_accuracy + '% prediction accuracy');
  if (state.dream_age_hours != null) metaParts.push('Last analysis: ' + (state.dream_age_hours < 1 ? 'just now' : state.dream_age_hours + 'h ago'));
  if (state.meta_insight) metaParts.push(state.meta_insight);
  document.getElementById('meta').innerHTML = metaParts.join(' &middot; ');

  // Crisis mode
  const crisis = document.getElementById('crisis');
  if (state.display_state === 'crisis' && state.actions.length > 0) {
    const a = state.actions[0];
    document.getElementById('crisis-title').textContent = a.summary;
    document.getElementById('crisis-detail').textContent = a.project ? 'Project: ' + a.project : '';
    currentActionId = a.id;
    crisis.classList.add('active');
  } else {
    crisis.classList.remove('active');
  }

  // Pulse mode (show top action as sliding card)
  if (state.display_state === 'pulse' && state.actions.length > 0 && !crisis.classList.contains('active')) {
    const a = state.actions[0];
    document.getElementById('pulse-type').textContent = a.type;
    document.getElementById('pulse-title').textContent = a.summary;
    document.getElementById('pulse-project').textContent = a.project ? a.project : '';
    currentActionId = a.id;

    const card = document.getElementById('pulse-card');
    card.classList.add('visible');

    clearTimeout(pulseTimeout);
    pulseTimeout = setTimeout(() => card.classList.remove('visible'), 60000);
  }
}

async function approveAction() {
  if (!currentActionId) return;
  try {
    await fetch('/api/approve-action', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: currentActionId })
    });
    document.getElementById('pulse-card').classList.remove('visible');
    document.getElementById('crisis').classList.remove('active');
    currentActionId = null;
    fetchState();
  } catch (e) { console.error(e); }
}

function dismissPulse() {
  document.getElementById('pulse-card').classList.remove('visible');
  currentActionId = null;
}

// Touch/mouse shows cursor
document.addEventListener('mousemove', () => document.body.classList.add('interactive'));
document.addEventListener('touchstart', () => document.body.classList.add('interactive'));
let hideTimer;
document.addEventListener('mousemove', () => {
  clearTimeout(hideTimer);
  hideTimer = setTimeout(() => document.body.classList.remove('interactive'), 5000);
});

// Poll every 30s
fetchState();
setInterval(fetchState, 30000);

// Update clock every minute
setInterval(() => {
  const now = new Date();
  document.getElementById('clock').textContent =
    now.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' }) +
    ' ' + now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
}, 60000);
</script>
</body>
</html>`;
}
