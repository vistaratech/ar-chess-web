/*
 * app.js — camera loop, automatic board tracking and the AR overlay.
 *
 * The camera frame is drawn into the same canvas the overlay is drawn on, which
 * keeps the outline and the arrows in exact registration no matter how the
 * canvas is scaled by CSS.
 */

import { Chess } from '../vendor/chess.js';
import { BoardTracker, BoardSampler, project } from './vision.js';
import { MoveReader, inferMove } from './track.js';

const MAX_EDGE = 720;          // detection resolution, long edge
const MS = 1800;               // engine time budget
const DEMO = new URLSearchParams(location.search).has('demo');

const view = document.getElementById('view');
const ctx = view.getContext('2d', { willReadFrequently: true });
const statusText = document.getElementById('statusText');
const dot = document.getElementById('dot');
const bestEl = document.getElementById('best');
const hintEl = document.getElementById('hint');
const sideSel = document.getElementById('side');

const video = document.createElement('video');
video.playsInline = true;
video.muted = true;
video.autoplay = true;

let vw = 640, vh = 480;
let tracker = new BoardTracker({ side: sideSel.value });
let reader = new MoveReader();
let game = new Chess();
let suggestion = null;         // { from, to, san, score, depth }
let worker = null;
let thinking = false;
let lastDesc = null;           // descriptor of the last sampled frame
const sampler = new BoardSampler();   // the grid descriptors are sampled on
let frames = 0;
let stepMs = 0;                // duration of the last processed frame
let stepAvg = 0;               // smoothed duration, for the on-device readout
let stillFrame = false;
let occluded = false;          // a hand/arm is over the board right now
let status = { text: 'Starting camera…', tone: '' };

/* ------------------------------------------------------------------ */
/* engine                                                              */
/* ------------------------------------------------------------------ */

function startWorker() {
  try {
    worker = new Worker('./js/engine.js', { type: 'module' });
    worker.onmessage = (e) => {
      const m = e.data;
      if (m.type === 'info') return;
      if (m.type === 'best') {
        thinking = false;
        if (!m.from || m.fen !== game.fen()) return;
        suggestion = { from: m.from, to: m.to, san: m.san, score: m.score, depth: m.depth };
        bestEl.textContent = describeSuggestion();
      }
    };
    worker.onerror = () => { worker = null; };
  } catch {
    worker = null;
  }
}

function describeSuggestion() {
  if (!suggestion) return '';
  const pawns = suggestion.score / 100;
  const sign = pawns > 0 ? '+' : '';
  return `${suggestion.san}   ${sign}${pawns.toFixed(1)}`;
}

function askEngine() {
  if (!worker) { bestEl.textContent = 'engine unavailable'; return; }
  if (game.game_over()) {
    suggestion = null;
    bestEl.textContent = game.in_checkmate() ? 'checkmate' : 'draw';
    return;
  }
  thinking = true;
  bestEl.textContent = 'thinking…';
  worker.postMessage({ type: 'think', fen: game.fen(), ms: MS });
}

/* ------------------------------------------------------------------ */
/* camera                                                              */
/* ------------------------------------------------------------------ */

async function start() {
  if (DEMO) {
    vw = 640; vh = 360;
    view.width = vw; view.height = vh;
    await startDemo();
    startWorker();
    askEngine();
    requestAnimationFrame(rafLoop);
    return;
  }

  if (!navigator.mediaDevices?.getUserMedia) {
    setStatus('Camera needs HTTPS or localhost', 'bad');
    return;
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        facingMode: { ideal: 'environment' },
        width: { ideal: 1280 },
        height: { ideal: 720 },
      },
    });
    video.srcObject = stream;
    await video.play();
  } catch (err) {
    setStatus(`Camera unavailable: ${err.message}`, 'bad');
    return;
  }

  const scale = Math.min(1, MAX_EDGE / Math.max(video.videoWidth, video.videoHeight));
  vw = Math.max(64, Math.round(video.videoWidth * scale));
  vh = Math.max(64, Math.round(video.videoHeight * scale));
  view.width = vw;
  view.height = vh;

  startWorker();
  askEngine();
  startLoop();
}

/* ------------------------------------------------------------------ */
/* demo source (no camera): renders the synthetic test scene           */
/* ------------------------------------------------------------------ */

let demo = null;

async function startDemo() {
  const [{ Chess }, scene] = await Promise.all([
    import('../vendor/chess.js'),
    import('../tests/scene.js'),
  ]);
  demo = {
    Chess,
    scene,
    game: new Chess(),
    quad: scene.makePose(640, 360, { tilt: 0.28, size: Math.min(640, 360) * 0.86 }),
    script: ['e4', 'c5', 'Nf3', 'd6', 'd4', 'cxd4', 'Nxd4', 'Nf6'],
    index: 0,
    next: performance.now() + 2200,
  };
  document.getElementById('hint').classList.add('show');
  document.getElementById('hintExtra').textContent = 'Demo mode: a synthetic board is playing through the Spanish opening.';
  // the synthetic scene draws the board from White's side of the table
  sideSel.value = 'w';
  tracker = new BoardTracker({ side: 'w' });
  reader = new MoveReader();
}

function renderDemo(now) {
  if (demo.index < demo.script.length && now > demo.next) {
    demo.game.move(demo.script[demo.index++]);
    demo.next = now + 2400;
  }
  demo.scene.renderScene(ctx, {
    w: vw, h: vh, fen: demo.game.fen(), quad: demo.quad,
    border: 0.02, light: 0.05, noise: 4, seed: 7 + demo.index,
  });
}

/* ------------------------------------------------------------------ */
/* main loop                                                           */
/* ------------------------------------------------------------------ */

/**
 * One pass over the newest camera frame.
 *
 * The tracker decides how much work is needed: on a frame where nothing moved
 * it returns the previous descriptor and we only redraw the overlay, so the
 * loop stays at camera rate. Everything expensive (board search, ridge snap,
 * square sampling) happens only on frames that actually changed.
 */
function step(now) {
  const t0 = performance.now();
  if (DEMO) renderDemo(now);
  else {
    if (video.readyState < 2) return;
    ctx.drawImage(video, 0, 0, vw, vh);
  }

  frames++;

  let res;
  try {
    res = tracker.update(ctx.getImageData(0, 0, vw, vh).data, vw, vh);
  } catch (err) {
    setStatus(`Vision error: ${err.message}`, 'bad');
    return;
  }

  if (res.H) {
    // On a still frame the sampling grid and the pixels are both unchanged, so
    // the descriptor is exactly the previous one: reuse it instead of sampling
    // 64 squares again.
    let desc;
    if (res.still && lastDesc) {
      desc = lastDesc;
    } else {
      desc = sampler.see(res.prepared, vw, vh, res);
      lastDesc = desc;
    }
    const r = reader.push(desc, { gridMoved: res.gridMoved, now: performance.now() });
    occluded = !!r.implausible;
    if (r.settled || r.stuck) readBoard(desc, r);
    else if (!r.changed.size && sampler.drift(res) > 0.04) {
      // Nothing is changing, so the reference can follow the board: move the
      // sampling grid onto the squares it is sampling and re-base from there.
      // Doing this while a change is pending would throw that change away.
      lastDesc = sampler.refresh(res.prepared, vw, vh, res);
      reader.commit(lastDesc);
    }
  } else {
    lastDesc = null;
    sampler.reset();
    occluded = false;
  }

  updateStatus(res);
  drawOverlay();

  const dt = performance.now() - t0;
  stepMs = dt;
  stepAvg = stepAvg ? stepAvg * 0.9 + dt * 0.1 : dt;
  stillFrame = res.still;
}

/** Schedule `step` on every new camera frame (or the next animation frame). */
function rafLoop(now) {
  step(now);
  requestAnimationFrame(rafLoop);
}

function startLoop() {
  if (typeof video.requestVideoFrameCallback === 'function') {
    const onVideo = () => {
      step(performance.now());
      video.requestVideoFrameCallback(onVideo);
    };
    video.requestVideoFrameCallback(onVideo);
    return;
  }
  requestAnimationFrame(rafLoop);
}

function readBoard(desc, r) {
  // Too much changed to be a move: a hand, an arm, or the board being handled.
  // Keep the confirmed position as the reference and wait — the move being
  // played underneath the hand is read as soon as the board is clear again.
  // (Only after the change set has been stable for several seconds does the
  // reader insist on a re-baseline, which is what `stuck` means.)
  if (r.implausible && !r.stuck) {
    setStatus('Hand over the board — waiting for a clear view', '');
    return;
  }

  const inf = inferMove(game.moves({ verbose: true }), r.changed);
  if (inf.accepted) {
    game.move({ from: inf.move.from, to: inf.move.to, promotion: inf.move.promotion || 'q' });
    reader.commit(desc);
    suggestion = null;
    setStatus(`Move read: ${inf.move.san}`, 'ok');
    askEngine();
    return;
  }
  // Nothing conclusive this time: take the frame as the new reference so the
  // next move is measured from here instead of piling up differences.
  reader.commit(desc);
  setStatus(r.stuck
    ? 'Board changed a lot — tap Resync if that was not a hand'
    : 'Could not read that move — tap Resync', 'bad');
}

function updateStatus(res) {
  if (performance.now() < holdStatus) return;
  if (!res.quad) {
    setStatus('Looking for a chessboard…', '');
    return;
  }
  if (occluded) {
    setStatus('Hand over the board — waiting for a clear view', '');
    return;
  }
  if (!thinking && game.turn() === tracker.side) {
    const label = game.turn() === 'w' ? 'White' : 'Black';
    setStatus(`Board locked · suggested move for ${label}`, 'ok');
  } else if (!thinking) {
    setStatus('Board locked · watching for your move', 'ok');
  }
}

let holdStatus = 0;

function setStatus(text, tone) {
  if (status.text === text) return;
  status = { text, tone };
  statusText.textContent = text;
  dot.className = tone || '';
  // keep transient messages on screen for a moment instead of letting the
  // idle status overwrite them on the next frame
  holdStatus = tone === 'bad' || text.startsWith('Move read') ? performance.now() + 2600 : 0;
}

/* ------------------------------------------------------------------ */
/* overlay                                                             */
/* ------------------------------------------------------------------ */

function drawOverlay() {
  const q = tracker.quad;
  if (!q) return;

  ctx.save();
  ctx.lineJoin = 'round';

  // board outline: dark under-stroke instead of a canvas shadow (a real blur
  // pass per frame is far more expensive than one extra stroke)
  const lw = Math.max(2, vw * 0.004);
  ctx.beginPath();
  for (let i = 0; i < 4; i++) {
    const [x, y] = q[i];
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  }
  ctx.closePath();
  ctx.lineWidth = lw * 2.4;
  ctx.strokeStyle = 'rgba(0, 0, 0, .45)';
  ctx.stroke();
  ctx.lineWidth = lw;
  ctx.strokeStyle = 'rgba(64, 214, 182, .95)';
  ctx.stroke();

  // corner ticks
  const r = Math.max(3, vw * 0.008);
  ctx.fillStyle = 'rgba(64, 214, 182, .95)';
  for (const [x, y] of q) {
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }

  if (suggestion && tracker.H && game.turn() === tracker.side) {
    drawMove(tracker.H, suggestion);
  }
  ctx.restore();
}

function squareCenter(H, square) {
  const f = 'abcdefgh'.indexOf(square[0]);
  const r = Number(square[1]) - 1;
  return project(H, f + 0.5, r + 0.5);
}

function drawMove(H, mv) {
  const a = squareCenter(H, mv.from);
  const b = squareCenter(H, mv.to);
  if (!a || !b) return;

  const dx = b[0] - a[0], dy = b[1] - a[1];
  const len = Math.hypot(dx, dy);
  if (len < 4) return;
  const ux = dx / len, uy = dy / len;

  // shorten so the arrow sits inside the squares
  const inset = len * 0.18;
  const ax = a[0] + ux * inset, ay = a[1] + uy * inset;
  const bx = b[0] - ux * inset * 0.7, by = b[1] - uy * inset * 0.7;

  const width = Math.max(4, len * 0.075);
  const head = Math.max(7, len * 0.22);

  ctx.save();
  ctx.strokeStyle = 'rgba(127, 240, 170, .95)';
  ctx.fillStyle = 'rgba(127, 240, 170, .95)';
  ctx.lineCap = 'round';

  // dark pass first so the arrow reads on a light board without a shadow blur
  ctx.strokeStyle = 'rgba(0, 0, 0, .35)';
  ctx.lineWidth = width * 1.7;
  ctx.beginPath();
  ctx.moveTo(ax, ay);
  ctx.lineTo(bx - ux * head * 0.55, by - uy * head * 0.55);
  ctx.stroke();

  ctx.strokeStyle = 'rgba(127, 240, 170, .95)';
  ctx.lineWidth = width;
  ctx.beginPath();
  ctx.moveTo(ax, ay);
  ctx.lineTo(bx - ux * head * 0.55, by - uy * head * 0.55);
  ctx.stroke();

  const nx = -uy, ny = ux;
  ctx.beginPath();
  ctx.moveTo(bx, by);
  ctx.lineTo(bx - ux * head + nx * head * 0.5, by - uy * head + ny * head * 0.5);
  ctx.lineTo(bx - ux * head - nx * head * 0.5, by - uy * head - ny * head * 0.5);
  ctx.closePath();
  ctx.fill();

  // ring on the destination square so a drop is unambiguous
  const f = 'abcdefgh'.indexOf(mv.to[0]);
  const rank = Number(mv.to[1]) - 1;
  const c0 = project(H, f + 0.12, rank + 0.12);
  const c1 = project(H, f + 0.88, rank + 0.88);
  if (c0 && c1) {
    ctx.lineWidth = Math.max(2, width * 0.35);
    ctx.strokeStyle = 'rgba(127, 240, 170, .55)';
    ctx.beginPath();
    ctx.ellipse((c0[0] + c1[0]) / 2, (c0[1] + c1[1]) / 2,
      Math.abs(c1[0] - c0[0]) / 2 || 1, Math.abs(c1[1] - c0[1]) / 2 || 1, 0, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.restore();
}

/* ------------------------------------------------------------------ */
/* controls                                                            */
/* ------------------------------------------------------------------ */

sideSel.addEventListener('change', () => {
  tracker = new BoardTracker({ side: sideSel.value });
  reader = new MoveReader();
  lastDesc = null;
  sampler.reset();
  suggestion = null;
  setStatus('Switched side — hold the board in view', '');
  askEngine();
});

document.getElementById('resync').addEventListener('click', () => {
  game = new Chess();
  reader = new MoveReader();
  lastDesc = null;
  sampler.reset();
  suggestion = null;
  setStatus('Reset to the start position', 'ok');
  askEngine();
});

document.getElementById('undo').addEventListener('click', () => {
  if (game.undo()) {
    suggestion = null;
    reader = new MoveReader();
    lastDesc = null;
    sampler.reset();
    setStatus(`Took back to move ${game.history().length}`, '');
    askEngine();
  }
});

document.getElementById('info').addEventListener('click', () => {
  const open = hintEl.classList.toggle('show');
  document.getElementById('title').classList.toggle('show', !open);
  if (!open) return;
  document.getElementById('hintExtra').innerHTML =
    'Reads moves from the <b>starting position</b>: it watches which squares change and ' +
    'matches that against the legal moves, so it works for a game played from the start ' +
    'in one session. It cannot read an arbitrary mid-game position off a photo — that ' +
    'needs a piece-recognition model this page does not ship. Use <b>Resync</b> to start again.';
});

start();

/* Small introspection hook, handy from the console and for automated checks. */
window.__ar = () => ({
  locked: tracker.locked,
  score: Number(tracker.score.toFixed(2)),
  scoreTrim: Number(tracker.scoreTrim.toFixed(2)),
  quadShift: Number((tracker.quadShift || 0).toFixed(2)),
  frames,
  ms: Number(stepMs.toFixed(2)),
  avgMs: Number(stepAvg.toFixed(2)),
  still: stillFrame,
  occluded,
  motion: Number((tracker.motion ?? 0).toFixed(2)),
  status: status.text,
  turn: game.turn(),
  history: game.history(),
  suggestion: suggestion && suggestion.san,
});
