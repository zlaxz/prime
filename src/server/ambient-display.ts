// ============================================================
// Prime Ambient Display v3 — Content-First Constellation
//
// The constellation is BACKGROUND. The CONTENT is foreground.
// Real actions, real narrative, real intelligence — not a number.
// Arc Reactor theme from prime-production.
// ============================================================

export function getAmbientDisplayHTML(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="apple-mobile-web-app-capable" content="yes">
<title>PRIME</title>
<style>
  @import url('https://fonts.googleapis.com/css2?family=Inter:wght@200;300;400;500;600;700&display=swap');

  :root {
    --bg: #0A0E14;
    --surface: rgba(15, 20, 30, 0.85);
    --surface-hover: rgba(20, 28, 40, 0.9);
    --arc: #00d9ff;
    --arc-glow: rgba(0, 217, 255, 0.12);
    --arc-dim: rgba(0, 217, 255, 0.06);
    --arc-border: rgba(0, 217, 255, 0.15);
    --text: #e0e0e8;
    --text-sec: #8899aa;
    --text-faint: #3a4555;
    --green: #4ade80;
    --yellow: #f59e0b;
    --coral: #FF6B6B;
    --purple: #9D4EDD;
  }

  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: 'Inter', -apple-system, sans-serif;
    background: var(--bg);
    color: var(--text);
    height: 100vh; width: 100vw;
    overflow: hidden;
    cursor: none; user-select: none;
  }
  body.interactive { cursor: default; }
  body.privacy .has-text { opacity: 0 !important; }
  body.privacy canvas { opacity: 1 !important; }

  canvas { position: fixed; inset: 0; z-index: 0; }

  .app { position: relative; z-index: 10; height: 100vh; display: grid; grid-template-rows: auto 1fr auto; padding: 32px 40px; }

  /* ── TOP BAR ─────────────────────────── */
  .topbar { display: flex; justify-content: space-between; align-items: flex-start; }

  .topbar-left { }
  .brand { font-size: 13px; font-weight: 600; letter-spacing: 3px; text-transform: uppercase; color: var(--arc); opacity: 0.6; }
  .clock { font-size: 14px; font-weight: 300; color: var(--text-sec); margin-top: 4px; opacity: 0.5; }

  .topbar-right { text-align: right; }
  .cal-event { font-size: 13px; color: var(--text-sec); margin-bottom: 4px; opacity: 0.6; }
  .cal-time { color: var(--arc); font-weight: 500; margin-right: 8px; }
  .cal-next { font-size: 11px; color: var(--yellow); margin-top: 2px; }

  /* ── MAIN CONTENT ────────────────────── */
  .main { display: grid; grid-template-columns: 1fr 380px; gap: 40px; align-items: center; overflow: hidden; }

  /* Left: The One Thing + narrative */
  .left { padding-right: 20px; }

  .one-thing-label { font-size: 11px; text-transform: uppercase; letter-spacing: 2.5px; color: var(--arc); margin-bottom: 12px; font-weight: 500; opacity: 0.7; }

  .one-thing {
    font-size: 32px; font-weight: 400; line-height: 1.4;
    color: var(--text);
    max-width: 600px;
    margin-bottom: 28px;
  }

  .insight {
    font-size: 14px; font-weight: 300; color: var(--text-sec);
    line-height: 1.7; max-width: 550px;
    border-left: 2px solid var(--arc-border);
    padding-left: 16px;
    opacity: 0.6;
  }

  .stats-row {
    display: flex; gap: 24px; margin-top: 28px;
  }

  .stat { font-size: 12px; color: var(--text-faint); }
  .stat-val { font-size: 20px; font-weight: 300; color: var(--text-sec); }
  .stat-val.green { color: var(--green); }
  .stat-val.yellow { color: var(--yellow); }
  .stat-val.red { color: var(--coral); }

  /* Right: Action cards */
  .right { display: flex; flex-direction: column; gap: 12px; max-height: 70vh; overflow-y: auto; }
  .right::-webkit-scrollbar { display: none; }

  .action-card {
    background: var(--surface);
    border: 1px solid var(--arc-border);
    border-radius: 12px;
    padding: 16px 20px;
    backdrop-filter: blur(12px);
    transition: all 0.2s;
    cursor: pointer;
  }
  .action-card:hover { background: var(--surface-hover); border-color: var(--arc); }
  .action-card.selected { border-color: var(--arc); box-shadow: 0 0 20px var(--arc-glow); }

  .action-type {
    font-size: 10px; text-transform: uppercase; letter-spacing: 2px;
    margin-bottom: 6px; font-weight: 500;
  }
  .action-type.email { color: var(--arc); }
  .action-type.reminder { color: var(--yellow); }
  .action-type.calendar { color: var(--purple); }

  .action-title { font-size: 15px; font-weight: 500; line-height: 1.4; margin-bottom: 4px; }
  .action-project { font-size: 12px; color: var(--text-faint); }

  .action-btns { display: flex; gap: 8px; margin-top: 12px; }

  .btn {
    padding: 8px 20px; border-radius: 8px;
    font-size: 13px; font-weight: 500; font-family: inherit;
    border: none; cursor: pointer; transition: all 0.15s;
  }
  .btn-arc { background: var(--arc); color: var(--bg); }
  .btn-arc:hover { filter: brightness(1.15); }
  .btn-dim { background: rgba(255,255,255,0.05); color: var(--text-sec); }
  .btn-dim:hover { background: rgba(255,255,255,0.1); }

  /* ── Thread chips (bottom) ──────────── */
  .thread-bar {
    display: flex; gap: 12px; align-items: center;
    overflow-x: auto; padding-top: 8px;
  }
  .thread-bar::-webkit-scrollbar { display: none; }

  .thread-label { font-size: 10px; text-transform: uppercase; letter-spacing: 2px; color: var(--text-faint); flex-shrink: 0; }

  .thread-chip {
    flex-shrink: 0;
    background: var(--arc-dim);
    border: 1px solid rgba(0, 217, 255, 0.06);
    border-radius: 6px;
    padding: 6px 14px;
    font-size: 12px; color: var(--text-sec);
  }

  /* ── Empty state ────────────────────── */
  .empty-state {
    display: flex; flex-direction: column;
    align-items: center; justify-content: center;
    height: 100%; opacity: 0.4;
  }
  .empty-state .icon { font-size: 48px; margin-bottom: 12px; }
  .empty-state .msg { font-size: 15px; color: var(--text-sec); }

  /* ── Bottom bar ─────────────────────── */
  .bottombar { display: flex; justify-content: space-between; align-items: flex-end; }
  .bottombar-left { font-size: 11px; color: var(--text-faint); opacity: 0.3; }
  .bottombar-right { font-size: 11px; color: var(--text-faint); opacity: 0.25; text-align: right; }

  .privacy-badge {
    position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%);
    font-size: 12px; letter-spacing: 4px; text-transform: uppercase;
    color: var(--arc); opacity: 0; z-index: 200;
    transition: opacity 0.5s;
  }
  body.privacy .privacy-badge { opacity: 0.3; }
</style>
</head>
<body>

<canvas id="c"></canvas>
<div class="privacy-badge">PRIVATE</div>

<div class="app has-text">
  <div class="topbar">
    <div class="topbar-left">
      <div class="brand">PRIME</div>
      <div class="clock" id="clock"></div>
    </div>
    <div class="topbar-right" id="calendar"></div>
  </div>

  <div class="main">
    <div class="left">
      <div class="one-thing-label">THE ONE THING</div>
      <div class="one-thing" id="oneThing">Loading...</div>
      <div class="insight" id="insight"></div>
      <div class="stats-row">
        <div class="stat"><div class="stat-val" id="actionCount">0</div>actions pending</div>
        <div class="stat"><div class="stat-val" id="itemCount">0</div>knowledge items</div>
        <div class="stat"><div class="stat-val" id="dreamAge">-</div>hours since analysis</div>
        <div class="stat"><div class="stat-val" id="predAcc">-</div>prediction accuracy</div>
      </div>
    </div>

    <div class="right" id="actions">
      <div class="empty-state"><div class="icon">&#10003;</div><div class="msg">Nothing needs your attention</div></div>
    </div>
  </div>

  <div class="bottombar">
    <div class="bottombar-left">
      <div class="thread-bar" id="threads">
        <span class="thread-label">Threads</span>
      </div>
    </div>
    <div class="bottombar-right" id="meta"></div>
  </div>
</div>

<script>
// ── Subtle particle background ───────────────────────
const canvas = document.getElementById('c');
const ctx = canvas.getContext('2d');
let W, H, time = 0;
const P = [];

function resize() {
  W = canvas.width = window.innerWidth;
  H = canvas.height = window.innerHeight;
}
window.addEventListener('resize', resize);
resize();

const N = 80; // fewer particles — content is the focus
for (let i = 0; i < N; i++) {
  P.push({ x: Math.random()*W, y: Math.random()*H, vx: (Math.random()-0.5)*0.1, vy: (Math.random()-0.5)*0.08, s: Math.random()*1.5+0.3, ph: Math.random()*6.28 });
}

function draw() {
  ctx.clearRect(0, 0, W, H);
  time += 0.001;
  // Subtle center glow
  const g = ctx.createRadialGradient(W/2, H/2, 0, W/2, H/2, W*0.5);
  g.addColorStop(0, 'rgba(0,217,255,0.02)');
  g.addColorStop(1, 'transparent');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);

  for (const p of P) {
    p.x += p.vx + Math.sin(time*2+p.ph)*0.03;
    p.y += p.vy + Math.cos(time*1.5+p.ph)*0.025;
    if (p.x<-10) p.x=W+10; if (p.x>W+10) p.x=-10;
    if (p.y<-10) p.y=H+10; if (p.y>H+10) p.y=-10;
    const a = (Math.sin(time*3+p.ph)*0.15+0.85)*0.15;
    ctx.beginPath(); ctx.arc(p.x, p.y, p.s, 0, 6.28);
    ctx.fillStyle = 'rgba(0,217,255,'+a+')';
    ctx.fill();
  }
  // Sparse connections
  for (let i=0;i<P.length;i++) for (let j=i+1;j<P.length;j++) {
    const d = Math.hypot(P[i].x-P[j].x, P[i].y-P[j].y);
    if (d < 150) {
      ctx.beginPath(); ctx.moveTo(P[i].x,P[i].y); ctx.lineTo(P[j].x,P[j].y);
      ctx.strokeStyle='rgba(0,217,255,'+(1-d/150)*0.03+')'; ctx.lineWidth=0.5; ctx.stroke();
    }
  }
  requestAnimationFrame(draw);
}
draw();

// ── State ────────────────────────────────────────────
let state = {};

async function fetchState() {
  try { state = await (await fetch('/api/ambient')).json(); render(); }
  catch { document.getElementById('oneThing').textContent = 'Reconnecting...'; }
}

function render() {
  const now = new Date();
  document.getElementById('clock').textContent =
    now.toLocaleDateString('en-US',{weekday:'long',month:'long',day:'numeric'}) + '  ' +
    now.toLocaleTimeString('en-US',{hour:'2-digit',minute:'2-digit'});

  // The One Thing
  document.getElementById('oneThing').textContent = state.one_thing || 'Nothing urgent. Go build.';

  // Insight (meta insight from strategic reflection)
  const insightEl = document.getElementById('insight');
  if (state.meta_insight) { insightEl.textContent = state.meta_insight; insightEl.style.display = 'block'; }
  else { insightEl.style.display = 'none'; }

  // Stats
  const n = state.actions_pending || 0;
  const acEl = document.getElementById('actionCount');
  acEl.textContent = n;
  acEl.className = 'stat-val ' + (n===0?'green':n<=2?'yellow':'red');
  document.getElementById('itemCount').textContent = state.knowledge_items || 0;
  document.getElementById('dreamAge').textContent = state.dream_age_hours != null ? state.dream_age_hours : '-';
  document.getElementById('predAcc').textContent = state.prediction_accuracy ? state.prediction_accuracy+'%' : '-';

  // Calendar
  const calEl = document.getElementById('calendar');
  if (state.calendar_today?.length > 0) {
    const events = state.calendar_today.filter(e => e.title !== 'Home').slice(0, 4);
    if (events.length > 0) {
      calEl.innerHTML = events.map(e => {
        const t = e.time && !e.time.endsWith('Z') ? new Date(e.time).toLocaleTimeString('en-US',{hour:'numeric',minute:'2-digit'}) : '';
        return '<div class="cal-event"><span class="cal-time">'+(t||'')+'</span>'+(e.title||'').slice(0,40)+'</div>';
      }).join('');
    } else {
      calEl.innerHTML = '<div class="cal-event" style="opacity:0.3">Clear schedule</div>';
    }
  }

  // Action cards
  const actionsEl = document.getElementById('actions');
  if (state.actions?.length > 0) {
    actionsEl.innerHTML = state.actions.map(a =>
      '<div class="action-card" data-id="'+a.id+'" onclick="selectAction(this,'+a.id+')">' +
        '<div class="action-type '+a.type+'">'+a.type+'</div>' +
        '<div class="action-title">'+a.summary+'</div>' +
        (a.project ? '<div class="action-project">'+a.project+'</div>' : '') +
        '<div class="action-btns">' +
          '<button class="btn btn-arc" onclick="event.stopPropagation();approve('+a.id+')">Approve</button>' +
          '<button class="btn btn-dim" onclick="event.stopPropagation();dismiss('+a.id+')">Skip</button>' +
        '</div>' +
      '</div>'
    ).join('');
  } else {
    actionsEl.innerHTML = '<div class="empty-state"><div class="icon" style="color:var(--green)">&#10003;</div><div class="msg">All clear. Nothing pending.</div></div>';
  }

  // Threads
  const tEl = document.getElementById('threads');
  if (state.threads?.length > 0) {
    tEl.innerHTML = '<span class="thread-label">Threads</span>' +
      state.threads.map(t => '<div class="thread-chip">'+(t.title||'').slice(0,30)+'</div>').join('');
  }

  // Meta
  document.getElementById('meta').textContent = state.knowledge_items + ' items  ·  Analysis: ' +
    (state.dream_age_hours < 1 ? 'fresh' : state.dream_age_hours + 'h ago');
}

function selectAction(el, id) {
  document.querySelectorAll('.action-card').forEach(c => c.classList.remove('selected'));
  el.classList.add('selected');
}

async function approve(id) {
  await fetch('/api/approve-action', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({id})});
  fetchState();
}

async function dismiss(id) {
  // Just remove from view for now
  document.querySelector('[data-id="'+id+'"]')?.remove();
}

// Privacy + keyboard
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') document.body.classList.toggle('privacy');
});

let ht; document.addEventListener('mousemove', () => {
  document.body.classList.add('interactive');
  clearTimeout(ht); ht = setTimeout(() => document.body.classList.remove('interactive'), 4000);
});

fetchState();
setInterval(fetchState, 30000);
setInterval(() => {
  const now = new Date();
  document.getElementById('clock').textContent =
    now.toLocaleDateString('en-US',{weekday:'long',month:'long',day:'numeric'}) + '  ' +
    now.toLocaleTimeString('en-US',{hour:'2-digit',minute:'2-digit'});
}, 60000);
</script>
</body>
</html>`;
}
