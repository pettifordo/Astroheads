'use strict';

// ─── Canvas ───────────────────────────────────────────────────────────────────
const canvas = document.getElementById('game');
const ctx    = canvas.getContext('2d');

function resize() {
  canvas.width  = window.innerWidth;
  canvas.height = window.innerHeight;
}
resize();
window.addEventListener('resize', () => { resize(); generateStars(); });

// ─── Constants ────────────────────────────────────────────────────────────────
const TURN_SPEED   = 3.8;      // degrees per frame
const THRUST       = 0.26;
const MAX_SPEED    = 7;
const DRAG         = 0.989;
const SHIP_R       = 13;       // collision radius

const BULLET_SPD   = 13;
const BULLET_LIFE  = 50;       // frames
const MAX_BULLETS  = 6;
const SHOOT_CD     = 10;       // frames between shots

const SIZES  = { big: 52, mid: 26, sml: 13 };
const POINTS = { big: 20, mid: 50, sml: 100 };
const BASE_SPD = { big: 1.1, mid: 1.8, sml: 2.7 };

const COLORS = [
  { stroke: '#FF6B6B', fill: 'rgba(255,107,107,0.18)' },
  { stroke: '#FF9F43', fill: 'rgba(255,159,67,0.18)'  },
  { stroke: '#A29BFE', fill: 'rgba(162,155,254,0.18)' },
  { stroke: '#00CEC9', fill: 'rgba(0,206,201,0.18)'   },
  { stroke: '#55EFC4', fill: 'rgba(85,239,196,0.18)'  },
  { stroke: '#FDCB6E', fill: 'rgba(253,203,110,0.18)' },
  { stroke: '#E84393', fill: 'rgba(232,67,147,0.18)'  },
  { stroke: '#74B9FF', fill: 'rgba(116,185,255,0.18)' },
];

const ROUND_SECS  = 60;
const START_LIVES = 5;
const RESPAWN_DELAY = 2.2;   // seconds
const ROUND_END_DELAY = 3.2; // seconds
const INVINCIBLE_SECS = 3.0;

// ─── State ────────────────────────────────────────────────────────────────────
let phase;        // 'title' | 'playing' | 'dead' | 'roundOver' | 'gameOver'
let phaseTimer;
let score, lives, round, speedMult, timeLeft;
let ship, asteroids, bullets, particles, stars;
let shootCd = 0;
let deadShip = null;

// ─── High Score state ─────────────────────────────────────────────────────────
let highScores      = [];
let initialsLetters = ['A', 'A', 'A'];
let initialsSlot    = 0;
const ALPHABET      = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const initialsZones = {};

function mobileSizeMult() {
  return navigator.maxTouchPoints > 0 ? 0.75 : 1.0;
}
async function fetchHighScores() {
  try { highScores = await (await fetch('/api/scores')).json(); } catch(e) { highScores = []; }
}
async function submitHighScore(name, sc, rnd) {
  try { highScores = await (await fetch('/api/scores', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ name, score: sc, round: rnd }) })).json(); } catch(e) {}
}
function qualifiesForHighScore(s) {
  if (s <= 0) return false;
  if (highScores.length < 10) return true;
  return s > highScores[highScores.length - 1].score;
}
function cycleInitial(dir) {
  const idx = ALPHABET.indexOf(initialsLetters[initialsSlot]);
  initialsLetters[initialsSlot] = ALPHABET[(idx + dir + 26) % 26];
}
async function confirmInitials() {
  await submitHighScore(initialsLetters.join(''), score, round);
  initialsLetters = ['A','A','A'];
  initialsSlot = 0;
  phase = 'title';
}

// ─── Input ────────────────────────────────────────────────────────────────────
const keys = {};
window.addEventListener('keydown', e => {
  if (['Space','ArrowUp','ArrowDown','ArrowLeft','ArrowRight','Enter'].includes(e.code))
    e.preventDefault();
  if (phase === 'enterInitials') {
    if (e.code === 'ArrowUp')                      cycleInitial(1);
    else if (e.code === 'ArrowDown')               cycleInitial(-1);
    else if (e.code === 'ArrowRight')              initialsSlot = Math.min(2, initialsSlot + 1);
    else if (e.code === 'ArrowLeft')               initialsSlot = Math.max(0, initialsSlot - 1);
    else if (e.code === 'Enter' || e.code === 'Space') confirmInitials();
    return;
  }
  keys[e.code] = true;
  if (e.code === 'Space' && (phase === 'title' || phase === 'gameOver'))
    startGame();
});
window.addEventListener('keyup', e => { keys[e.code] = false; });

// ─── Touch Controls ───────────────────────────────────────────────────────────
// Button definitions — positions are fractions of canvas size, set in drawTouchControls
const TOUCH_BTNS = [
  { id: 'left',   key: 'ArrowLeft',  label: '◀',  side: 'left'  },
  { id: 'thrust', key: 'ArrowUp',    label: '▲',  side: 'left'  },
  { id: 'right',  key: 'ArrowRight', label: '▶',  side: 'left'  },
  { id: 'fire',   key: 'Space',      label: '●',  side: 'right' },
];

// Resolved pixel positions updated each draw frame
const btnPos = {};

function btnRadius() {
  return Math.round(Math.min(canvas.width, canvas.height) * 0.085);
}

function resolveBtnPositions() {
  const R  = btnRadius();
  const W  = canvas.width;
  const H  = canvas.height;
  const pad = R * 1.35;
  // Left cluster — triangle of three buttons bottom-left
  btnPos['left']   = { x: pad,           y: H - pad };
  btnPos['thrust'] = { x: pad + R * 1.6, y: H - pad - R * 1.6 };
  btnPos['right']  = { x: pad + R * 3.2, y: H - pad };
  // Fire — large button bottom-right
  btnPos['fire']   = { x: W - pad,       y: H - pad };
}

const activeTouches = {}; // touchIdentifier → button id

function btnAtPoint(x, y) {
  const R = btnRadius() + 14; // slightly generous hit area
  for (const btn of TOUCH_BTNS) {
    const p = btnPos[btn.id];
    if (p && Math.hypot(x - p.x, y - p.y) < R) return btn;
  }
  return null;
}

canvas.addEventListener('touchstart', e => {
  e.preventDefault();
  for (const t of e.changedTouches) {
    // Title / game-over: any tap starts the game
    if (phase === 'title' || phase === 'gameOver') { startGame(); continue; }
    const btn = btnAtPoint(t.clientX, t.clientY);
    if (btn) { activeTouches[t.identifier] = btn.id; keys[btn.key] = true; }
  }
}, { passive: false });

canvas.addEventListener('touchmove', e => {
  e.preventDefault();
  for (const t of e.changedTouches) {
    const prev = activeTouches[t.identifier];
    const btn  = btnAtPoint(t.clientX, t.clientY);
    // Finger slid onto a different button
    if (btn && btn.id !== prev) {
      if (prev) { const old = TOUCH_BTNS.find(b => b.id === prev); if (old) keys[old.key] = false; }
      activeTouches[t.identifier] = btn.id;
      keys[btn.key] = true;
    } else if (!btn && prev) {
      // Slid off all buttons
      const old = TOUCH_BTNS.find(b => b.id === prev);
      if (old) keys[old.key] = false;
      delete activeTouches[t.identifier];
    }
  }
}, { passive: false });

function releaseTouches(e) {
  e.preventDefault();
  for (const t of e.changedTouches) {
    const id = activeTouches[t.identifier];
    if (id) { const btn = TOUCH_BTNS.find(b => b.id === id); if (btn) keys[btn.key] = false; }
    delete activeTouches[t.identifier];
  }
}
canvas.addEventListener('touchend',    releaseTouches, { passive: false });
canvas.addEventListener('touchcancel', releaseTouches, { passive: false });

function drawTouchControls() {
  if (!('ontouchstart' in window) && !navigator.maxTouchPoints) return;
  if (phase === 'title' || phase === 'gameOver' || phase === 'enterInitials') return;

  resolveBtnPositions();
  const R = btnRadius();

  TOUCH_BTNS.forEach(btn => {
    const p      = btnPos[btn.id];
    const active = !!keys[btn.key];
    const isFire = btn.id === 'fire';
    const r      = isFire ? R * 1.25 : R;

    ctx.save();

    // Outer glow when pressed
    if (active) {
      ctx.shadowColor = isFire ? '#FF6B6B' : '#74B9FF';
      ctx.shadowBlur  = 28;
    }

    // Button circle fill
    ctx.beginPath();
    ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
    ctx.fillStyle = active
      ? (isFire ? 'rgba(255,107,107,0.45)' : 'rgba(116,185,255,0.38)')
      : 'rgba(255,255,255,0.07)';
    ctx.fill();

    // Border
    ctx.strokeStyle = active
      ? (isFire ? '#FF6B6B' : '#74B9FF')
      : 'rgba(255,255,255,0.28)';
    ctx.lineWidth = active ? 2.5 : 1.5;
    ctx.stroke();

    // Icon label
    ctx.shadowBlur    = active ? 12 : 0;
    ctx.shadowColor   = isFire ? '#FF6B6B' : '#74B9FF';
    ctx.fillStyle     = active ? '#ffffff' : 'rgba(255,255,255,0.55)';
    ctx.font          = `bold ${Math.round(r * 0.7)}px "Courier New", monospace`;
    ctx.textAlign     = 'center';
    ctx.textBaseline  = 'middle';
    ctx.globalAlpha   = active ? 1 : 0.7;
    ctx.fillText(btn.label, p.x, p.y);

    ctx.restore();
  });
  ctx.globalAlpha = 1;
}

// ─── Head images ──────────────────────────────────────────────────────────────
const HEAD_FILES = ['Boris', 'Filipa', 'Frank', 'Simon', 'Vincent'];
const headImages = [];
let imagesLoaded = 0;

HEAD_FILES.forEach((name, i) => {
  const img = new Image();
  img.onload = () => { imagesLoaded++; };
  img.src = `heads/${name}.jpeg`;
  headImages.push({ img, name });
});

// ─── Boot ─────────────────────────────────────────────────────────────────────
stars      = [];
asteroids  = [];
bullets    = [];
particles  = [];
phase      = 'title';
score      = 0;
lives      = START_LIVES;
round      = 1;
ship       = dummyShip();
generateStars();
fetchHighScores();
requestAnimationFrame(loop);

// ─── Game flow ────────────────────────────────────────────────────────────────
function startGame() {
  score     = 0;
  lives     = START_LIVES;
  round     = 1;
  speedMult = 1;
  initRound('playing');
}

function initRound(nextPhase) {
  timeLeft  = ROUND_SECS;
  bullets   = [];
  particles = [];
  asteroids = [];
  speedMult = 1 + (round - 1) * 0.22;
  ship      = makeShip();

  const count = 3 + round;
  for (let i = 0; i < count; i++) spawnBigAsteroid();
  phase = nextPhase || 'playing';
}

function dummyShip() {
  return { x: canvas.width / 2, y: canvas.height / 2,
           angle: -Math.PI / 2, vx: 0, vy: 0,
           invSecs: 0, thrusting: false };
}

function makeShip() {
  return { x: canvas.width / 2, y: canvas.height / 2,
           angle: -Math.PI / 2, vx: 0, vy: 0,
           invSecs: INVINCIBLE_SECS, thrusting: false };
}

function spawnBigAsteroid() {
  let x, y;
  do {
    x = Math.random() * canvas.width;
    y = Math.random() * canvas.height;
  } while (Math.hypot(x - ship.x, y - ship.y) < 160);
  asteroids.push(makeAsteroid(x, y, 'big', randColor()));
}

function makeAsteroid(x, y, size, col) {
  const r   = SIZES[size] * mobileSizeMult();
  const spd = BASE_SPD[size] * speedMult;
  const a   = Math.random() * Math.PI * 2;
  const n   = 8 + Math.floor(Math.random() * 5);
  const verts = Array.from({ length: n }, (_, i) => {
    const ang = (i / n) * Math.PI * 2;
    const len = r * (0.68 + Math.random() * 0.32);
    return [Math.cos(ang) * len, Math.sin(ang) * len];
  });
  const headIdx = Math.floor(Math.random() * headImages.length);
  return { x, y, vx: Math.cos(a) * spd, vy: Math.sin(a) * spd,
           rot: Math.random() * Math.PI * 2,
           rotSpd: (Math.random() - 0.5) * 0.045,
           r, size, col, verts, headIdx };
}

function randColor() { return COLORS[Math.floor(Math.random() * COLORS.length)]; }

// ─── Main loop ────────────────────────────────────────────────────────────────
let lastTs = null;
function loop(ts) {
  if (!lastTs) lastTs = ts;
  const dtSec = Math.min((ts - lastTs) / 1000, 0.1);
  lastTs = ts;
  const dt = dtSec * 60; // physics delta (~1 at 60fps)

  update(dtSec, dt);
  draw();
  requestAnimationFrame(loop);
}

// ─── Update ───────────────────────────────────────────────────────────────────
function update(dtSec, dt) {
  // Particles always update
  updateParticles(dt);

  if (phase === 'title' || phase === 'gameOver') return;

  if (phase === 'roundOver') {
    phaseTimer -= dtSec;
    if (phaseTimer <= 0) { round++; initRound('playing'); }
    return;
  }

  if (phase === 'dead') {
    phaseTimer -= dtSec;
    if (phaseTimer <= 0) {
      if (lives <= 0) {
        if (qualifiesForHighScore(score)) {
          initialsLetters = ['A','A','A'];
          initialsSlot    = 0;
          phase = 'enterInitials';
        } else {
          phase = 'gameOver';
        }
      } else {
        ship  = makeShip();
        phase = 'playing';
      }
    }
    return;
  }

  // ── playing ──────────────────────────────────────────────────────────────

  // Timer
  timeLeft -= dtSec;
  if (timeLeft <= 0) {
    timeLeft   = 0;
    phase      = 'roundOver';
    phaseTimer = ROUND_END_DELAY;
    return;
  }

  // Ship controls
  ship.thrusting = false;
  if (keys['ArrowLeft'])  ship.angle -= TURN_SPEED * (Math.PI / 180) * dt;
  if (keys['ArrowRight']) ship.angle += TURN_SPEED * (Math.PI / 180) * dt;

  if (keys['ArrowUp']) {
    ship.thrusting = true;
    ship.vx += Math.cos(ship.angle) * THRUST * dt;
    ship.vy += Math.sin(ship.angle) * THRUST * dt;
    const spd = Math.hypot(ship.vx, ship.vy);
    if (spd > MAX_SPEED) { ship.vx = (ship.vx / spd) * MAX_SPEED; ship.vy = (ship.vy / spd) * MAX_SPEED; }

    // Exhaust particles
    if (Math.random() < 0.6) {
      const ea = ship.angle + Math.PI + (Math.random() - 0.5) * 0.55;
      const es = 2.5 + Math.random() * 2.5;
      particles.push({
        x: ship.x + Math.cos(ship.angle + Math.PI) * 12,
        y: ship.y + Math.sin(ship.angle + Math.PI) * 12,
        vx: Math.cos(ea) * es, vy: Math.sin(ea) * es,
        life: 14 + Math.random() * 10, maxLife: 24,
        size: 2.5 + Math.random() * 2,
        col: ['#FF9F43','#FDCB6E','#ffffff','#FF6B6B'][Math.floor(Math.random() * 4)],
        type: 'exhaust'
      });
    }
  }

  ship.vx = ship.vx * Math.pow(DRAG, dt);
  ship.vy = ship.vy * Math.pow(DRAG, dt);
  ship.x  = wrap(ship.x + ship.vx * dt, canvas.width);
  ship.y  = wrap(ship.y + ship.vy * dt, canvas.height);
  if (ship.invSecs > 0) ship.invSecs -= dtSec;

  // Shoot
  if (shootCd > 0) shootCd -= dt;
  if (keys['Space'] && shootCd <= 0 && bullets.length < MAX_BULLETS) {
    bullets.push({
      x: ship.x + Math.cos(ship.angle) * 18,
      y: ship.y + Math.sin(ship.angle) * 18,
      vx: Math.cos(ship.angle) * BULLET_SPD + ship.vx * 0.25,
      vy: Math.sin(ship.angle) * BULLET_SPD + ship.vy * 0.25,
      life: BULLET_LIFE
    });
    shootCd = SHOOT_CD;
  }

  // Bullets
  bullets = bullets.filter(b => {
    b.x = wrap(b.x + b.vx * dt, canvas.width);
    b.y = wrap(b.y + b.vy * dt, canvas.height);
    b.life -= dt;
    return b.life > 0;
  });

  // Asteroids
  asteroids.forEach(a => {
    a.x   = wrap(a.x + a.vx * dt, canvas.width);
    a.y   = wrap(a.y + a.vy * dt, canvas.height);
    a.rot += a.rotSpd * dt;
  });

  // ── Collisions ──────────────────────────────────────────────────────────

  const deadBullets = new Set();
  const deadRocks   = new Set();
  const newRocks    = [];

  bullets.forEach((b, bi) => {
    asteroids.forEach((a, ai) => {
      if (deadRocks.has(ai)) return;
      if (Math.hypot(b.x - a.x, b.y - a.y) < a.r + 3) {
        deadBullets.add(bi);
        deadRocks.add(ai);
        score += POINTS[a.size];
        explodeAsteroid(a);
        if (a.size === 'big') {
          newRocks.push(makeAsteroid(a.x, a.y, 'mid', a.col));
          newRocks.push(makeAsteroid(a.x, a.y, 'mid', randColor()));
        } else if (a.size === 'mid') {
          newRocks.push(makeAsteroid(a.x, a.y, 'sml', a.col));
          newRocks.push(makeAsteroid(a.x, a.y, 'sml', randColor()));
        }
      }
    });
  });

  bullets   = bullets.filter((_, i) => !deadBullets.has(i));
  asteroids = asteroids.filter((_, i) => !deadRocks.has(i));
  asteroids.push(...newRocks);

  // All heads cleared — start next round immediately
  if (asteroids.length === 0) {
    phase      = 'roundOver';
    phaseTimer = ROUND_END_DELAY;
    return;
  }

  // Ship vs asteroids
  if (ship.invSecs <= 0) {
    for (const a of asteroids) {
      if (Math.hypot(ship.x - a.x, ship.y - a.y) < a.r + SHIP_R) {
        killShip();
        break;
      }
    }
  }
}

function updateParticles(dt) {
  particles = particles.filter(p => {
    p.x += p.vx * dt;
    p.y += p.vy * dt;
    p.vx *= 0.975;
    p.vy *= 0.975;
    p.life -= dt;
    return p.life > 0;
  });
}

function explodeAsteroid(a) {
  const n = 14 + Math.floor(Math.random() * 8);
  for (let i = 0; i < n; i++) {
    const ang = Math.random() * Math.PI * 2;
    const spd = 1.2 + Math.random() * 3.5;
    particles.push({
      x: a.x, y: a.y,
      vx: Math.cos(ang) * spd, vy: Math.sin(ang) * spd,
      life: 28 + Math.random() * 32, maxLife: 60,
      size: 1.5 + Math.random() * 2.5,
      col: a.col.stroke, type: 'debris'
    });
  }
}

function killShip() {
  lives--;
  deadShip = { x: ship.x, y: ship.y };
  // Ship explosion
  for (let i = 0; i < 24; i++) {
    const ang = Math.random() * Math.PI * 2;
    const spd = 2 + Math.random() * 5;
    particles.push({
      x: ship.x, y: ship.y,
      vx: Math.cos(ang) * spd, vy: Math.sin(ang) * spd,
      life: 35 + Math.random() * 35, maxLife: 70,
      size: 2 + Math.random() * 3,
      col: ['#74B9FF','#A29BFE','#ffffff','#00CEC9'][Math.floor(Math.random() * 4)],
      type: 'debris'
    });
  }
  phase      = 'dead';
  phaseTimer = RESPAWN_DELAY;
}

function wrap(v, max) {
  if (v < 0) return v + max;
  if (v >= max) return v - max;
  return v;
}

// ─── Draw ─────────────────────────────────────────────────────────────────────
function draw() {
  // Deep space background
  ctx.fillStyle = '#06060F';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  drawStars();
  drawParticles();
  asteroids.forEach(drawAsteroid);
  drawBullets();

  // Ship (blink while invincible)
  if (phase === 'playing') {
    const blink = ship.invSecs > 0 && Math.floor(ship.invSecs * 8) % 2 === 0;
    if (!blink) drawShip();
  }

  drawHUD();

  if (phase === 'title')          drawTitle();
  if (phase === 'roundOver')      drawRoundOver();
  if (phase === 'gameOver')       drawGameOver();
  if (phase === 'enterInitials')  drawInitialsEntry();

  drawTouchControls();
}

// ── Stars ─────────────────────────────────────────────────────────────────────
function generateStars() {
  stars = Array.from({ length: 200 }, () => ({
    x: Math.random() * canvas.width,
    y: Math.random() * canvas.height,
    r: Math.random() * 1.4 + 0.2,
    brightness: 0.25 + Math.random() * 0.75,
    twinkle: Math.random() * Math.PI * 2
  }));
}

function drawStars() {
  const t = performance.now() * 0.0008;
  stars.forEach(s => {
    ctx.globalAlpha = s.brightness * (0.55 + 0.45 * Math.sin(t + s.twinkle));
    ctx.fillStyle   = '#ffffff';
    ctx.beginPath();
    ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
    ctx.fill();
  });
  ctx.globalAlpha = 1;
}

// ── Ship ──────────────────────────────────────────────────────────────────────
function drawShip() {
  ctx.save();
  ctx.translate(ship.x, ship.y);
  ctx.rotate(ship.angle);

  // Thruster flame
  if (ship.thrusting) {
    const fl = 20 + Math.random() * 14;
    ctx.beginPath();
    ctx.moveTo(-11, -5);
    ctx.lineTo(-11 - fl, 0);
    ctx.lineTo(-11, 5);
    ctx.closePath();
    const fg = ctx.createLinearGradient(-11, 0, -11 - fl, 0);
    fg.addColorStop(0,   'rgba(255,220,60,0.95)');
    fg.addColorStop(0.35,'rgba(255,110,20,0.80)');
    fg.addColorStop(1,   'rgba(255,40,0,0)');
    ctx.fillStyle = fg;
    ctx.shadowColor = '#FF9F43';
    ctx.shadowBlur  = 22;
    ctx.fill();
    ctx.shadowBlur = 0;
  }

  // Glow aura
  ctx.shadowColor = '#74B9FF';
  ctx.shadowBlur  = 18;

  // Main hull — swept back fighter shape
  ctx.beginPath();
  ctx.moveTo(22, 0);       // nose tip
  ctx.lineTo(10, -5);      // right shoulder
  ctx.lineTo(-5, -11);     // right wing outer
  ctx.lineTo(-13, -7);     // right wing inner
  ctx.lineTo(-11, 0);      // rear centre dip
  ctx.lineTo(-13, 7);      // left wing inner
  ctx.lineTo(-5, 11);      // left wing outer
  ctx.lineTo(10, 5);       // left shoulder
  ctx.closePath();

  const hg = ctx.createLinearGradient(-13, 0, 22, 0);
  hg.addColorStop(0,   '#0652DD');
  hg.addColorStop(0.45,'#0984E3');
  hg.addColorStop(1,   '#74B9FF');
  ctx.fillStyle   = hg;
  ctx.strokeStyle = '#CAF0F8';
  ctx.lineWidth   = 1.3;
  ctx.fill();
  ctx.stroke();

  // Cockpit canopy
  ctx.shadowColor = '#A29BFE';
  ctx.shadowBlur  = 12;
  ctx.beginPath();
  ctx.ellipse(8, 0, 7, 4.5, 0, 0, Math.PI * 2);
  const cg = ctx.createRadialGradient(6, -1.5, 0.5, 8, 0, 7);
  cg.addColorStop(0,   '#E0D6FF');
  cg.addColorStop(0.55,'#7C6FCD');
  cg.addColorStop(1,   '#3D35A0');
  ctx.fillStyle   = cg;
  ctx.strokeStyle = 'rgba(210,200,255,0.55)';
  ctx.lineWidth   = 0.9;
  ctx.fill();
  ctx.stroke();

  // Wing accent lines
  ctx.shadowBlur  = 0;
  ctx.strokeStyle = 'rgba(180,240,255,0.3)';
  ctx.lineWidth   = 1;
  ctx.beginPath(); ctx.moveTo(7, -4);  ctx.lineTo(-8, -10); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(7, 4);   ctx.lineTo(-8, 10);  ctx.stroke();

  // Engine nozzles
  ctx.fillStyle   = '#1a1aff';
  ctx.shadowColor = '#74B9FF';
  ctx.shadowBlur  = 8;
  ctx.beginPath(); ctx.ellipse(-12, -5, 3.5, 2.2, 0.25,  0, Math.PI * 2); ctx.fill();
  ctx.beginPath(); ctx.ellipse(-12,  5, 3.5, 2.2, -0.25, 0, Math.PI * 2); ctx.fill();

  ctx.restore();
}

// ── Heads (asteroids) ─────────────────────────────────────────────────────────
function drawAsteroid(a) {
  const head = headImages[a.headIdx];
  const r    = a.r;

  ctx.save();
  ctx.translate(a.x, a.y);
  ctx.rotate(a.rot);

  // Clip to circle and draw photo
  ctx.beginPath();
  ctx.arc(0, 0, r, 0, Math.PI * 2);
  ctx.clip();

  if (head && head.img.complete && head.img.naturalWidth > 0) {
    ctx.drawImage(head.img, -r, -r, r * 2, r * 2);
  } else {
    // Fallback while loading
    ctx.fillStyle = a.col.fill;
    ctx.fill();
  }

  ctx.restore();

  // Glowing coloured border (drawn outside clip so it sits on top)
  ctx.save();
  ctx.translate(a.x, a.y);
  ctx.shadowColor = a.col.stroke;
  ctx.shadowBlur  = 14;
  ctx.strokeStyle = a.col.stroke;
  ctx.lineWidth   = a.size === 'big' ? 3.5 : a.size === 'mid' ? 2.5 : 2;
  ctx.beginPath();
  ctx.arc(0, 0, r, 0, Math.PI * 2);
  ctx.stroke();

  // Name label on large heads only
  if (a.size === 'big' && head) {
    ctx.shadowBlur  = 6;
    ctx.shadowColor = '#000';
    ctx.fillStyle   = '#ffffff';
    ctx.font        = `bold ${Math.max(10, Math.round(r * 0.28))}px "Courier New", monospace`;
    ctx.textAlign   = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(head.name.toUpperCase(), 0, r + 14);
  }

  ctx.restore();
}

// ── Bullets ───────────────────────────────────────────────────────────────────
function drawBullets() {
  bullets.forEach(b => {
    ctx.save();
    ctx.shadowColor = '#FDCB6E';
    ctx.shadowBlur  = 10;
    ctx.fillStyle   = '#fff8e1';
    ctx.beginPath();
    ctx.arc(b.x, b.y, 3, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  });
}

// ── Particles ─────────────────────────────────────────────────────────────────
function drawParticles() {
  particles.forEach(p => {
    const alpha = Math.max(0, p.life / p.maxLife);
    ctx.globalAlpha = alpha;
    ctx.shadowColor = p.col;
    ctx.shadowBlur  = p.type === 'exhaust' ? 6 : 5;
    ctx.fillStyle   = p.col;
    ctx.beginPath();
    ctx.arc(p.x, p.y, Math.max(0.1, p.size * alpha), 0, Math.PI * 2);
    ctx.fill();
  });
  ctx.globalAlpha = 1;
  ctx.shadowBlur  = 0;
}

// ── HUD ───────────────────────────────────────────────────────────────────────
function drawHUD() {
  if (phase === 'title' || phase === 'gameOver') return;
  ctx.save();

  const font = '"Courier New", monospace';

  // Score
  ctx.font         = `bold 18px ${font}`;
  ctx.fillStyle    = '#ffffff';
  ctx.shadowColor  = '#74B9FF';
  ctx.shadowBlur   = 8;
  ctx.textAlign    = 'left';
  ctx.fillText(`SCORE  ${score}`, 20, 38);

  // Round
  ctx.textAlign = 'center';
  ctx.fillText(`ROUND  ${round}`, canvas.width / 2, 38);

  // Timer
  const t    = Math.ceil(Math.max(0, timeLeft));
  const warn = t <= 10;
  ctx.fillStyle   = warn ? '#FF6B6B' : '#FDCB6E';
  ctx.shadowColor = warn ? '#FF6B6B' : '#FDCB6E';
  ctx.shadowBlur  = warn ? 18 : 8;
  ctx.font        = `bold ${warn ? 22 : 18}px ${font}`;
  ctx.fillText(`${t}s`, canvas.width / 2, 66);

  // Lives — mini ship icons
  for (let i = 0; i < lives; i++) {
    drawMiniShip(canvas.width - 28 - i * 26, 30);
  }

  ctx.restore();
}

function drawMiniShip(x, y) {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(-Math.PI / 2);
  ctx.scale(0.48, 0.48);
  ctx.beginPath();
  ctx.moveTo(22, 0);
  ctx.lineTo(-5, -11);
  ctx.lineTo(-11, 0);
  ctx.lineTo(-5, 11);
  ctx.closePath();
  ctx.fillStyle   = '#CAF0F8';
  ctx.shadowColor = '#74B9FF';
  ctx.shadowBlur  = 6;
  ctx.fill();
  ctx.restore();
}

// ── Helpers ───────────────────────────────────────────────────────────────────
const isTouch = () => ('ontouchstart' in window) || navigator.maxTouchPoints > 0;

// ── Overlay screens ───────────────────────────────────────────────────────────
function drawTitle() {
  const cx = canvas.width / 2;
  const f  = '"Courier New", monospace';
  const topY = canvas.height * 0.12;

  ctx.save();
  ctx.textAlign = 'center';

  ctx.font = `bold ${Math.min(68, canvas.width * 0.09)}px ${f}`;
  ctx.fillStyle = '#74B9FF'; ctx.shadowColor = '#74B9FF'; ctx.shadowBlur = 35;
  ctx.fillText('ASTROHEADS', cx, topY);

  ctx.font = `18px ${f}`; ctx.fillStyle = '#ffffff'; ctx.shadowBlur = 8;
  ctx.fillText('5 LIVES  ·  60 SECONDS PER ROUND', cx, topY + 38);
  ctx.font = `13px ${f}`; ctx.fillStyle = 'rgba(255,255,255,0.55)'; ctx.shadowBlur = 0;
  ctx.fillText(isTouch() ? '◀ ▶ TURN   ▲ THRUST   ● FIRE' : '← → TURN   ↑ THRUST   SPACE SHOOT', cx, topY + 62);

  drawHighScoreTable(cx, topY + 95);

  if (Math.floor(performance.now() / 520) % 2) {
    ctx.font = `bold 20px ${f}`; ctx.fillStyle = '#FDCB6E';
    ctx.shadowColor = '#FDCB6E'; ctx.shadowBlur = 16;
    ctx.fillText(isTouch() ? 'TAP  TO  START' : 'PRESS  SPACE  TO  START', cx, canvas.height * 0.92);
  }
  ctx.restore();
}

function drawRoundOver() {
  const cx = canvas.width / 2;
  const cy = canvas.height / 2;
  const f  = '"Courier New", monospace';

  ctx.save();
  ctx.textAlign = 'center';
  ctx.font        = `bold 52px ${f}`;
  ctx.fillStyle   = '#FDCB6E';
  ctx.shadowColor = '#FDCB6E';
  ctx.shadowBlur  = 30;
  ctx.fillText(`ROUND  ${round}  COMPLETE`, cx, cy - 20);

  ctx.font        = `20px ${f}`;
  ctx.fillStyle   = '#ffffff';
  ctx.shadowBlur  = 8;
  ctx.fillText(`SCORE: ${score}`, cx, cy + 28);
  ctx.font        = `16px ${f}`;
  ctx.fillStyle   = 'rgba(255,255,255,0.55)';
  ctx.fillText(`Round ${round + 1} incoming — speed ×${(1 + round * 0.22).toFixed(2)}`, cx, cy + 62);
  ctx.restore();
}

function drawGameOver() {
  const cx = canvas.width / 2;
  const cy = canvas.height / 2;
  const f  = '"Courier New", monospace';

  ctx.save();
  ctx.textAlign = 'center';
  ctx.font        = `bold 60px ${f}`;
  ctx.fillStyle   = '#FF6B6B';
  ctx.shadowColor = '#FF6B6B';
  ctx.shadowBlur  = 30;
  ctx.fillText('GAME  OVER', cx, cy - 50);

  ctx.font        = `24px ${f}`;
  ctx.fillStyle   = '#ffffff';
  ctx.shadowBlur  = 8;
  ctx.fillText(`SCORE: ${score}`, cx, cy + 5);
  ctx.font = `18px ${f}`;
  ctx.fillStyle = 'rgba(255,255,255,0.65)';
  ctx.fillText(`Reached Round ${round}`, cx, cy + 38);

  if (Math.floor(performance.now() / 520) % 2) {
    ctx.font        = `bold 20px ${f}`;
    ctx.fillStyle   = '#FDCB6E';
    ctx.shadowColor = '#FDCB6E';
    ctx.shadowBlur  = 14;
    ctx.fillText(isTouch() ? 'TAP  TO  PLAY  AGAIN' : 'PRESS  SPACE  TO  PLAY  AGAIN', cx, cy + 95);
  }
  ctx.restore();
}

// ── High Score Table ──────────────────────────────────────────────────────────
function drawHighScoreTable(cx, startY) {
  const f = '"Courier New", monospace';
  ctx.save();
  ctx.textAlign = 'center';

  ctx.font = `bold 15px ${f}`; ctx.fillStyle = '#FDCB6E';
  ctx.shadowColor = '#FDCB6E'; ctx.shadowBlur = 10;
  ctx.fillText('─── HIGH SCORES ───', cx, startY);

  if (highScores.length === 0) {
    ctx.font = `13px ${f}`; ctx.fillStyle = 'rgba(255,255,255,0.35)';
    ctx.shadowBlur = 0; ctx.fillText('NO SCORES YET', cx, startY + 26);
  } else {
    highScores.forEach((s, i) => {
      const y = startY + 24 + i * 22;
      ctx.font = `${i === 0 ? 'bold ' : ''}14px ${f}`;
      ctx.fillStyle = i === 0 ? '#FDCB6E' : i < 3 ? '#ffffff' : 'rgba(255,255,255,0.6)';
      ctx.shadowColor = i === 0 ? '#FDCB6E' : 'transparent'; ctx.shadowBlur = i === 0 ? 8 : 0;
      const rank = `${i+1}`.padStart(2,' ');
      const sc   = `${s.score}`.padStart(7,' ');
      ctx.fillText(`${rank}.  ${s.name}  ${sc}    RND ${s.round}`, cx, y);
    });
  }
  ctx.restore();
}

// ── Initials Entry ────────────────────────────────────────────────────────────
function drawInitialsEntry() {
  const cx = canvas.width / 2;
  const cy = canvas.height / 2;
  const f  = '"Courier New", monospace';
  const touch = isTouch();

  ctx.fillStyle = 'rgba(0,0,0,0.82)';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  ctx.save();
  ctx.textAlign = 'center';

  ctx.font = `bold 28px ${f}`; ctx.fillStyle = '#FDCB6E';
  ctx.shadowColor = '#FDCB6E'; ctx.shadowBlur = 22;
  ctx.fillText('★  NEW  HIGH  SCORE  ★', cx, cy - 130);

  ctx.font = `18px ${f}`; ctx.fillStyle = '#ffffff'; ctx.shadowBlur = 6;
  ctx.fillText(`SCORE: ${score}   ROUND: ${round}`, cx, cy - 95);

  ctx.font = `12px ${f}`; ctx.fillStyle = 'rgba(255,255,255,0.5)'; ctx.shadowBlur = 0;
  ctx.fillText(touch ? 'TAP ▲ ▼ TO CHANGE · TAP SLOT TO SELECT' : '▲▼ CHANGE   ◀▶ MOVE   ENTER TO SAVE', cx, cy - 68);

  const slotW = 64, slotH = 76, gap = 18;
  const totalW = 3 * slotW + 2 * gap;
  const sx0 = cx - totalW / 2;
  const slotTopY = cy - 50;

  for (let i = 0; i < 3; i++) {
    const sx     = sx0 + i * (slotW + gap);
    const active = i === initialsSlot;
    const arrowY = slotTopY - 28;
    const letterY = slotTopY + slotH - 16;
    const downY  = slotTopY + slotH + 26;

    initialsZones[`up_${i}`]   = { x: sx, y: arrowY - 20, w: slotW, h: 36, action: () => { initialsSlot = i; cycleInitial(1); } };
    initialsZones[`slot_${i}`] = { x: sx, y: slotTopY,    w: slotW, h: slotH, action: () => { initialsSlot = i; } };
    initialsZones[`dn_${i}`]   = { x: sx, y: downY - 8,   w: slotW, h: 36, action: () => { initialsSlot = i; cycleInitial(-1); } };

    ctx.font = `22px ${f}`;
    ctx.fillStyle = active ? '#FDCB6E' : 'rgba(255,255,255,0.35)';
    ctx.shadowColor = active ? '#FDCB6E' : 'transparent'; ctx.shadowBlur = active ? 10 : 0;
    ctx.fillText('▲', sx + slotW / 2, arrowY);

    ctx.strokeStyle = active ? '#FDCB6E' : 'rgba(255,255,255,0.25)';
    ctx.lineWidth = active ? 2.5 : 1.5;
    ctx.shadowColor = active ? '#FDCB6E' : 'transparent'; ctx.shadowBlur = active ? 18 : 0;
    if (active) { ctx.fillStyle = 'rgba(253,203,110,0.08)'; ctx.fillRect(sx, slotTopY, slotW, slotH); }
    ctx.strokeRect(sx, slotTopY, slotW, slotH);

    const blink = active && Math.floor(performance.now() / 350) % 2 === 0;
    ctx.font = `bold 50px ${f}`;
    ctx.fillStyle = blink ? 'rgba(253,203,110,0.25)' : (active ? '#FDCB6E' : '#ffffff');
    ctx.shadowColor = active ? '#FDCB6E' : 'rgba(255,255,255,0.2)'; ctx.shadowBlur = active ? 20 : 4;
    ctx.fillText(initialsLetters[i], sx + slotW / 2, letterY);

    ctx.font = `22px ${f}`;
    ctx.fillStyle = active ? '#FDCB6E' : 'rgba(255,255,255,0.35)';
    ctx.shadowColor = active ? '#FDCB6E' : 'transparent'; ctx.shadowBlur = active ? 10 : 0;
    ctx.fillText('▼', sx + slotW / 2, downY);
  }

  const btnY = cy + 115;
  initialsZones['confirm'] = { x: cx - 130, y: btnY - 28, w: 260, h: 50, action: confirmInitials };
  if (Math.floor(performance.now() / 520) % 2) {
    ctx.font = `bold 18px ${f}`; ctx.fillStyle = '#55EFC4';
    ctx.shadowColor = '#55EFC4'; ctx.shadowBlur = 14;
    ctx.fillText(touch ? 'TAP HERE TO SAVE' : 'PRESS  ENTER  TO  SAVE', cx, btnY);
  }
  if (touch) {
    ctx.strokeStyle = 'rgba(85,239,196,0.35)'; ctx.lineWidth = 1.5; ctx.shadowBlur = 0;
    ctx.strokeRect(cx - 130, btnY - 28, 260, 50);
  }

  ctx.restore();
}
