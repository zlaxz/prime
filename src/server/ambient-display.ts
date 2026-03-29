// ============================================================
// Prime Ambient Display v2 — Constellation Interface
//
// Living particle system where entities are stars,
// relationships are constellations, urgency is color.
// Arc Reactor cyan theme from prime-production.
// Privacy mode on Escape key (strips all text).
// Pulse cards slide up for pending actions.
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
  @import url('https://fonts.googleapis.com/css2?family=Inter:wght@200;300;400;500;600;700&display=swap');

  :root {
    --bg: #0A0E14;
    --arc-accent: #00d9ff;
    --arc-glow: rgba(0, 217, 255, 0.15);
    --arc-dim: rgba(0, 217, 255, 0.06);
    --text: #e0e0e8;
    --text-dim: #556680;
    --text-faint: #2a3445;
    --success: #4ade80;
    --success-glow: rgba(74, 222, 128, 0.1);
    --warning: #f59e0b;
    --warning-glow: rgba(245, 158, 11, 0.1);
    --danger: #ef4444;
    --danger-glow: rgba(239, 68, 68, 0.15);
    --coral: #FF6B6B;
    --purple: #9D4EDD;
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
  body.privacy .has-text { opacity: 0 !important; transition: opacity 0.5s; }
  body.privacy .privacy-safe { opacity: 1 !important; }

  canvas { position: fixed; top: 0; left: 0; width: 100%; height: 100%; z-index: 0; }

  /* ── Overlay layers ────────────────────── */
  .overlay { position: fixed; z-index: 10; pointer-events: none; }
  .overlay.interactive { pointer-events: auto; }

  /* ── Clock + date ──────────────────────── */
  .clock {
    top: 40px; left: 48px;
    font-size: 15px; font-weight: 300;
    color: var(--text-dim); opacity: 0.5;
    letter-spacing: 0.5px;
  }

  /* ── Status line ───────────────────────── */
  .status-line {
    bottom: 40px; left: 48px; right: 48px;
    display: flex; justify-content: space-between; align-items: flex-end;
  }

  .status-left { font-size: 13px; color: var(--text-faint); opacity: 0.4; }
  .status-right { font-size: 12px; color: var(--text-faint); opacity: 0.3; text-align: right; }

  /* ── Center message ────────────────────── */
  .center-block {
    top: 50%; left: 50%;
    transform: translate(-50%, -50%);
    text-align: center;
    max-width: 700px;
  }

  .center-count {
    font-size: 120px; font-weight: 200;
    letter-spacing: -4px;
    line-height: 1;
    margin-bottom: 16px;
    transition: color 0.8s;
  }

  .center-count.green { color: var(--success); text-shadow: 0 0 60px var(--success-glow); }
  .center-count.yellow { color: var(--warning); text-shadow: 0 0 60px var(--warning-glow); }
  .center-count.red { color: var(--coral); text-shadow: 0 0 80px var(--danger-glow); }

  .center-line {
    font-size: 18px; font-weight: 300;
    color: var(--text-dim);
    line-height: 1.6;
    opacity: 0.7;
  }

  /* ── Reactor ring (subtle, behind count) ── */
  .reactor-ring {
    position: absolute;
    top: 50%; left: 50%;
    transform: translate(-50%, -50%);
    width: 260px; height: 260px;
    border-radius: 50%;
    border: 1px solid var(--arc-dim);
    z-index: 5;
    pointer-events: none;
  }

  .reactor-ring::before {
    content: ''; position: absolute; inset: -8px;
    border-radius: 50%;
    border: 1px solid var(--arc-accent);
    opacity: 0.08;
    animation: ring-breathe 6s ease-in-out infinite;
  }

  .reactor-ring::after {
    content: ''; position: absolute; inset: 12px;
    border-radius: 50%;
    border: 1px solid var(--arc-accent);
    opacity: 0.04;
    animation: ring-breathe 6s ease-in-out infinite 3s;
  }

  @keyframes ring-breathe {
    0%, 100% { transform: scale(1); opacity: 0.05; }
    50% { transform: scale(1.06); opacity: 0.12; }
  }

  /* ── Calendar strip ────────────────────── */
  .calendar-strip {
    top: 40px; right: 48px;
    text-align: right;
  }

  .cal-event {
    font-size: 13px; color: var(--text-dim);
    margin-bottom: 6px; opacity: 0.5;
  }

  .cal-time { color: var(--arc-accent); font-weight: 500; }

  /* ── Thread chips ──────────────────────── */
  .thread-strip {
    bottom: 80px; left: 48px; right: 48px;
    display: flex; gap: 12px;
    overflow-x: hidden;
    opacity: 0.25;
    transition: opacity 0.5s;
  }

  .thread-chip {
    flex-shrink: 0;
    background: rgba(0, 217, 255, 0.04);
    border: 1px solid rgba(0, 217, 255, 0.08);
    border-radius: 8px;
    padding: 8px 16px;
    font-size: 12px;
  }

  .chip-title { font-weight: 500; color: var(--text-dim); }
  .chip-state { color: var(--text-faint); font-size: 11px; margin-top: 2px; }

  /* ── Pulse card ────────────────────────── */
  .pulse-card {
    position: fixed; z-index: 100;
    bottom: -220px; left: 50%;
    transform: translateX(-50%);
    width: min(88vw, 580px);
    background: linear-gradient(135deg, rgba(10, 14, 20, 0.95), rgba(20, 28, 40, 0.95));
    border: 1px solid rgba(0, 217, 255, 0.2);
    border-radius: 16px;
    padding: 28px 36px;
    backdrop-filter: blur(20px);
    box-shadow: 0 -8px 60px rgba(0, 217, 255, 0.08);
    transition: bottom 0.7s cubic-bezier(0.16, 1, 0.3, 1);
    pointer-events: auto;
  }

  .pulse-card.visible { bottom: 48px; }

  .pulse-type {
    font-size: 11px; text-transform: uppercase;
    letter-spacing: 2.5px; color: var(--arc-accent);
    margin-bottom: 10px; font-weight: 500;
  }

  .pulse-title {
    font-size: 22px; font-weight: 500;
    line-height: 1.3; margin-bottom: 6px;
  }

  .pulse-project { font-size: 13px; color: var(--text-dim); }

  .pulse-actions { display: flex; gap: 12px; margin-top: 24px; }

  .btn {
    padding: 14px 36px; border-radius: 10px;
    font-size: 15px; font-weight: 500; font-family: inherit;
    border: none; cursor: pointer; transition: all 0.2s;
  }

  .btn-arc {
    background: linear-gradient(135deg, var(--arc-accent), #00b8d4);
    color: #0A0E14;
  }
  .btn-arc:hover { filter: brightness(1.15); transform: translateY(-1px); }

  .btn-ghost {
    background: transparent;
    color: var(--text-dim);
    border: 1px solid rgba(255,255,255,0.08);
  }
  .btn-ghost:hover { border-color: var(--text-dim); }

  /* ── Privacy indicator ─────────────────── */
  .privacy-badge {
    position: fixed; top: 40px; left: 50%;
    transform: translateX(-50%);
    font-size: 11px; letter-spacing: 3px;
    text-transform: uppercase;
    color: var(--arc-accent); opacity: 0;
    transition: opacity 0.5s; z-index: 200;
  }
  body.privacy .privacy-badge { opacity: 0.4; }

  /* ── Transitions ───────────────────────── */
  .fade-in { animation: fadeIn 0.8s ease forwards; }
  @keyframes fadeIn { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: translateY(0); } }
</style>
</head>
<body>

<canvas id="constellation"></canvas>

<div class="reactor-ring privacy-safe"></div>

<div class="privacy-badge">PRIVATE MODE</div>

<div class="overlay clock has-text" id="clock"></div>

<div class="overlay calendar-strip has-text" id="calendar"></div>

<div class="overlay center-block" id="center">
  <div class="center-count has-text" id="count">0</div>
  <div class="center-line has-text" id="line">Connecting...</div>
</div>

<div class="overlay status-line">
  <div class="status-left has-text" id="meta"></div>
  <div class="status-right has-text" id="accuracy"></div>
</div>

<div class="overlay thread-strip has-text" id="threads"></div>

<div class="pulse-card has-text" id="pulse">
  <div class="pulse-type" id="pulse-type"></div>
  <div class="pulse-title" id="pulse-title"></div>
  <div class="pulse-project" id="pulse-project"></div>
  <div class="pulse-actions">
    <button class="btn btn-arc" onclick="approveAction()">Approve</button>
    <button class="btn btn-ghost" onclick="dismissPulse()">Later</button>
  </div>
</div>

<script>
// ── Constellation Particle System ────────────────────
const canvas = document.getElementById('constellation');
const ctx = canvas.getContext('2d');
let W, H, particles = [], connections = [];
let mouseX = -1, mouseY = -1;
let time = 0;

function resize() {
  W = canvas.width = window.innerWidth * devicePixelRatio;
  H = canvas.height = window.innerHeight * devicePixelRatio;
  canvas.style.width = window.innerWidth + 'px';
  canvas.style.height = window.innerHeight + 'px';
  ctx.scale(devicePixelRatio, devicePixelRatio);
}
window.addEventListener('resize', resize);
resize();

// Create particles
const PARTICLE_COUNT = Math.min(200, Math.floor(window.innerWidth * window.innerHeight / 8000));
for (let i = 0; i < PARTICLE_COUNT; i++) {
  particles.push({
    x: Math.random() * window.innerWidth,
    y: Math.random() * window.innerHeight,
    vx: (Math.random() - 0.5) * 0.15,
    vy: (Math.random() - 0.5) * 0.15,
    size: Math.random() * 2 + 0.5,
    brightness: Math.random() * 0.4 + 0.1,
    phase: Math.random() * Math.PI * 2,
    type: Math.random() < 0.15 ? 'accent' : 'normal', // 15% are accent colored
  });
}

function drawParticles() {
  const w = window.innerWidth, h = window.innerHeight;
  ctx.clearRect(0, 0, w, h);
  time += 0.002;

  // Background gradient
  const grad = ctx.createRadialGradient(w/2, h/2, 0, w/2, h/2, w * 0.6);
  grad.addColorStop(0, 'rgba(0, 217, 255, 0.015)');
  grad.addColorStop(0.5, 'rgba(0, 217, 255, 0.005)');
  grad.addColorStop(1, 'transparent');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, w, h);

  // Update + draw particles
  for (const p of particles) {
    // Gentle drift with sine wave
    p.x += p.vx + Math.sin(time + p.phase) * 0.05;
    p.y += p.vy + Math.cos(time * 0.7 + p.phase) * 0.04;

    // Wrap around
    if (p.x < -20) p.x = w + 20;
    if (p.x > w + 20) p.x = -20;
    if (p.y < -20) p.y = h + 20;
    if (p.y > h + 20) p.y = -20;

    // Pulsing brightness
    const pulse = Math.sin(time * 2 + p.phase) * 0.15 + 0.85;
    const alpha = p.brightness * pulse;

    ctx.beginPath();
    ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
    if (p.type === 'accent') {
      ctx.fillStyle = 'rgba(0, 217, 255, ' + (alpha * 0.8) + ')';
    } else {
      ctx.fillStyle = 'rgba(180, 200, 220, ' + (alpha * 0.5) + ')';
    }
    ctx.fill();

    // Glow for accent particles
    if (p.type === 'accent' && p.size > 1.2) {
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.size * 4, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(0, 217, 255, ' + (alpha * 0.04) + ')';
      ctx.fill();
    }
  }

  // Draw connections between nearby particles
  for (let i = 0; i < particles.length; i++) {
    for (let j = i + 1; j < particles.length; j++) {
      const dx = particles[i].x - particles[j].x;
      const dy = particles[i].y - particles[j].y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist < 120) {
        const alpha = (1 - dist / 120) * 0.06;
        ctx.beginPath();
        ctx.moveTo(particles[i].x, particles[i].y);
        ctx.lineTo(particles[j].x, particles[j].y);
        ctx.strokeStyle = 'rgba(0, 217, 255, ' + alpha + ')';
        ctx.lineWidth = 0.5;
        ctx.stroke();
      }
    }
  }

  requestAnimationFrame(drawParticles);
}
drawParticles();

// ── State Management ─────────────────────────────────
let state = {}, currentActionId = null, pulseTimeout = null;

async function fetchState() {
  try {
    const res = await fetch('/api/ambient');
    state = await res.json();
    render();
  } catch { document.getElementById('line').textContent = 'Reconnecting...'; }
}

function render() {
  const now = new Date();
  document.getElementById('clock').textContent =
    now.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' }) +
    '  ' + now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });

  // Count + color
  const n = state.actions_pending || 0;
  const countEl = document.getElementById('count');
  countEl.textContent = n;
  countEl.className = 'center-count has-text ' + (n === 0 ? 'green' : n <= 2 ? 'yellow' : 'red');

  // Adjust accent particles based on urgency
  const accentRatio = n === 0 ? 0.1 : n <= 2 ? 0.2 : 0.35;
  particles.forEach((p, i) => { p.type = i / particles.length < accentRatio ? 'accent' : 'normal'; });

  // Center line
  document.getElementById('line').textContent =
    n === 0 ? (state.one_thing || 'Nothing needs your attention.')
    : state.one_thing || n + ' item' + (n === 1 ? '' : 's') + ' need attention';

  // Calendar
  const cal = document.getElementById('calendar');
  if (state.calendar_today?.length > 0) {
    cal.innerHTML = state.calendar_today.slice(0, 4).map(e => {
      const t = e.time ? new Date(e.time).toLocaleTimeString('en-US', {hour:'numeric', minute:'2-digit'}) : '';
      return '<div class="cal-event"><span class="cal-time">' + t + '</span> ' + (e.title||'').slice(0,40) + '</div>';
    }).join('');
  } else {
    cal.innerHTML = '<div class="cal-event" style="opacity:0.2">No meetings today</div>';
  }

  // Threads
  const tEl = document.getElementById('threads');
  if (state.threads?.length > 0) {
    tEl.innerHTML = state.threads.map(t =>
      '<div class="thread-chip"><div class="chip-title">' + (t.title||'').slice(0,35) + '</div><div class="chip-state">' + (t.state||'').slice(0,50) + '</div></div>'
    ).join('');
  }

  // Meta
  const parts = [];
  if (state.knowledge_items) parts.push(state.knowledge_items + ' items');
  if (state.dream_age_hours != null) parts.push('Analysis: ' + (state.dream_age_hours < 1 ? 'fresh' : state.dream_age_hours + 'h ago'));
  document.getElementById('meta').textContent = parts.join('  ·  ');

  // Accuracy
  if (state.prediction_accuracy) {
    document.getElementById('accuracy').textContent = state.prediction_accuracy + '% prediction accuracy' +
      (state.meta_insight ? '  ·  ' + state.meta_insight : '');
  }

  // Pulse card for top pending action
  if (n > 0 && state.actions?.length > 0) {
    const a = state.actions[0];
    document.getElementById('pulse-type').textContent = a.type;
    document.getElementById('pulse-title').textContent = a.summary;
    document.getElementById('pulse-project').textContent = a.project || '';
    currentActionId = a.id;
    const card = document.getElementById('pulse');
    if (!card.classList.contains('visible')) {
      clearTimeout(pulseTimeout);
      setTimeout(() => card.classList.add('visible'), 3000); // slide up after 3s
      pulseTimeout = setTimeout(() => card.classList.remove('visible'), 63000); // hide after 60s
    }
  }
}

async function approveAction() {
  if (!currentActionId) return;
  try {
    await fetch('/api/approve-action', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({id: currentActionId}) });
    document.getElementById('pulse').classList.remove('visible');
    currentActionId = null;
    fetchState();
  } catch(e) { console.error(e); }
}

function dismissPulse() {
  document.getElementById('pulse').classList.remove('visible');
  currentActionId = null;
}

// ── Privacy Mode (Escape key) ────────────────────────
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') document.body.classList.toggle('privacy');
  if (e.key === ' ' || e.key === 'Enter') {
    if (currentActionId) approveAction();
  }
});

// ── Cursor hide ──────────────────────────────────────
let hideTimer;
document.addEventListener('mousemove', () => {
  document.body.classList.add('interactive');
  clearTimeout(hideTimer);
  hideTimer = setTimeout(() => document.body.classList.remove('interactive'), 4000);
});

// ── Poll ─────────────────────────────────────────────
fetchState();
setInterval(fetchState, 30000);
setInterval(() => {
  const now = new Date();
  document.getElementById('clock').textContent =
    now.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' }) +
    '  ' + now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
}, 60000);
</script>
</body>
</html>`;
}
