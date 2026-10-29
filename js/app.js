/*
 * app.js — camera loop, automatic board tracking and the AR overlay.
 *
 * The camera frame is drawn into the same canvas the overlay is drawn on, which
 * keeps the outline and the arrows in exact registration no matter how the
 * canvas is scaled by CSS.
 *
 * The game logic — what a change on the board means, whose move it is, and
 * whether the move that was recommended has actually been played — lives in
 * coach.js, so it can be tested without a camera. This file is the skin: camera,
 * tracker, reader, worker, overlay and status line.
 */

import { Chess } from '../vendor/chess.js';
import { BoardTracker, BoardSampler, project } from './vision.js';
import { MoveReader } from './track.js';
import { Coach } from './coach.js';

const MAX_EDGE = 720;          // detection resolution, long edge
const MS = 2000;               // engine time budget
const DEMO = new URLSearchParams(location.search).has('demo');
const SIDE_KEY = 'ar-chess.side';
const ENGINE_STALL_MS = 8000;  // a worker that has not answered by then is wedged
const ENGINE_RETRY_MS = 4000;  // backoff after a worker/engine failure

const view = document.getElementById('view');
const ctx = view.getContext('2d', { willReadFrequently: true });
const statusText = document.getElementById('statusText');
const dot = document.getElementById('dot');
const bestEl = document.getElementById('best');
const hintEl = document.getElementById('hint');
const sideSel = document.getElementById('side');

/** The side the player chose last time. White is the default: the coach is
 * most useful to the person moving up the board, and the request that led here
 * was "always show White's move". The selector still covers Black. */
function savedSide() {
  try {
    const s = localStorage.getItem(SIDE_KEY);
    if (s === 'w' || s === 'b') return s;
  } catch { /* private mode: fall through */ }
  return 'w';
}

const startSide = savedSide();
sideSel.value = startSide;

const video = document.createElement('video');
video.playsInline = true;
video.muted = true;
video.autoplay = true;

let vw = 640, vh = 480;
let tracker = new BoardTracker({ side: startSide });
let reader = new MoveReader();
const game = new Chess();
const coach = new Coach(game, { side: startSide });
let worker = null;
let lastDesc = null;           // descriptor of the last sampled frame
const sampler = new BoardSampler();   // the grid descriptors are sampled on
let frames = 0;
let stepMs = 0;                // duration of the last processed frame
let stepAvg = 0;               // smoothed duration, for the on-device readout
let stillFrame = false;
let occluded = false;          // a hand/arm is over the board right now
let desynced = false;          // a board change could not be read as a move
let holdStatus = 0;
let status = { text: 'Starting camera…', tone: '' };
let thinkingSince = 0;         // when the current think request went out
let lastAsk = 0;               // when the last request went out
let engineRetryAt = 0;         // do not restart/retry before this
let engineDepth = 0;
let engineNodes = 0;
let engineScore = 0;
let engineError = '';

/* ------------------------------------------------------------------ */
/* engine                                                              */
/* ------------------------------------------------------------------ */

function startWorker() {
  if (worker) return;
  try {
    worker = new Worker('./js/engine.js', { type: 'module' });
    worker.onmessage = (e) => {
      const m = e.data || {};
      if (m.type === 'error') {
        if (m.id === coach.req) coach.thinking = false;
        engineError = m.error || 'engine error';
        engineRetryAt = performance.now() + ENGINE_RETRY_MS;
        showBest();
        return;
      }
      if (m.type !== 'best') return;
      const live = m.id === coach.req;
      if (coach.best(m.id, m)) {
        holdStatus = 0;
        engineError = '';
        engineRetryAt = 0;
        engineDepth = m.depth || 0;
        engineNodes = m.nodes || 0;
        engineScore = m.score || 0;
      }
      if (live) showBest();
    };
    worker.onerror = () => {
      try { worker.terminate(); } catch { /* already gone */ }
      worker = null;
      coach.thinking = false;
      engineRetryAt = performance.now() + ENGINE_RETRY_MS;
      engineError = 'engine failed to load';
      showBest();
    };
  } catch {
    worker = null;
    engineRetryAt = performance.now() + ENGINE_RETRY_MS;
    engineError = 'engine unavailable';
  }
}

function describeSuggestion(s) {
  let value;
  if (Math.abs(s.score) > 90000) {
    // mate scores are stored as MATE - plies, relative to the side to move
    const plies = 100000 - Math.abs(s.score);
    value = `${s.score > 0 ? '#' : '#-'}${Math.max(1, Math.ceil(plies / 2))}`;
  } else {
    const pawns = s.score / 100;
    value = `${pawns > 0 ? '+' : ''}${pawns.toFixed(2)}`;
  }
  return `${s.san}   ${value}${s.depth ? `   d${s.depth}` : ''}`;
}

/**
 * The `best` line in the HUD. Empty while it is the opponent's turn: showing
 * their best move there reads as a recommendation to us, which it is not.
 */
function showBest() {
  const g = coach.guidance;
  if (g) bestEl.textContent = describeSuggestion(g);
  else if (coach.thinking) bestEl.textContent = 'thinking…';
  else if (engineError) bestEl.textContent = `${engineError} — retrying`;
  else if (game.game_over()) bestEl.textContent = game.in_checkmate() ? 'checkmate' : 'draw';
  else bestEl.textContent = '';
}

/**
 * Ask the coach for the next move and forward the request to the worker.
 *
 * The coach only asks when it is our turn: computing a move for the opponent
 * would only be overwritten by the position their move produces, and drawing it
 * would be wrong.
 */
function askEngine() {
  const req = coach.request();
  showBest();
  if (!req) return;
  if (!worker) {
    coach.thinking = false;
    engineRetryAt = performance.now() + ENGINE_RETRY_MS;
    showBest();
    return;
  }
  thinkingSince = performance.now();
  lastAsk = thinkingSince;
  try {
    worker.postMessage({ type: 'think', id: req.id, fen: req.fen, ms: MS });
  } catch {
    try { worker.terminate(); } catch { /* already gone */ }
    worker = null;
    coach.thinking = false;
    engineRetryAt = performance.now() + ENGINE_RETRY_MS;
    engineError = 'engine unavailable';
    showBest();
  }
}

/**
 * Guarantee that a suggestion exists whenever it is our turn.
 *
 * Before this, an answer could be lost for good: a worker that failed to load,
 * an engine that threw, an answer for a position that a spurious read had
 * already replaced, or a side change mid-think all left "thinking" or a blank
 * line with no request in flight. This watchdog is called once per frame and
 * re-asks (with a backoff) whenever it is our move and there is neither a
 * suggestion nor a live request. It never fights a request that is still
 * running; a worker that exceeds its budget is restarted.
 */
function ensureAdvice(now) {
  if (!coach.myTurn || coach.guidance || desynced) return;

  if (coach.thinking) {
    if (thinkingSince && now - thinkingSince < ENGINE_STALL_MS) return;
    // The worker accepted the request but never answered. Restart it rather
    // than sit in "thinking…" for the rest of the game.
    if (worker) { try { worker.terminate(); } catch { /* already gone */ } }
    worker = null;
    coach.thinking = false;
    engineError = 'engine stalled';
    engineRetryAt = now + ENGINE_RETRY_MS;
    showBest();
  }

  if (now < engineRetryAt) return;
  if (now - lastAsk < 600) return;

  if (!worker) {
    startWorker();
    if (!worker) return;
  }
  askEngine();
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
  const scene = await import('../tests/scene.js');
  const side = coach.side;
  demo = {
    scene,
    game: new Chess(),
    quad: scene.makePose(640, 360, {
      tilt: 0.28,
      size: Math.min(640, 360) * 0.86,
      flip: side === 'b',
    }),
    replies: ['c5', 'd6', 'Nf6', 'e6', 'Be7', 'a6', 'b5', 'O-O'],
    reply: 0,
    plays: 0,
    next: performance.now() + 1400,
    armed: 0,
  };
  hintEl.classList.add('show');
  document.getElementById('hintExtra').textContent =
    'Demo mode: a synthetic board plays both sides. Your move is the one the arrow shows.';
  tracker = new BoardTracker({ side });
  reader = new MoveReader();
}

/**
 * Drive the synthetic board the way a person would.
 *
 * `demo.game` is the *physical* board; the coach's game is what the camera has
 * read. Before every synthetic move the physical board is reloaded from the
 * read position, so a missed read can never leave the demo permanently out of
 * sync — it just retries from where the app actually is.
 *
 * Our move is always played exactly as the arrow says, which is what exercises
 * "recommend, then clear the arrow as soon as it is played" end to end.
 */
function maybeStepDemo(now) {
  if (!demo || now < demo.next) return;
  const live = coach.game;
  if (live.game_over() || demo.plays >= 60) return;

  demo.game.load(live.fen());

  if (coach.myTurn) {
    const g = coach.guidance;
    if (!g) { demo.next = now + 300; demo.armed = 0; return; }
    if (!demo.armed) demo.armed = now + 1800;   // show the arrow for a moment
    if (now < demo.armed) { demo.next = demo.armed; return; }
    demo.armed = 0;
    demo.game.move({ from: g.from, to: g.to, promotion: 'q' });
    demo.plays++;
    demo.next = now + 2400;
    return;
  }

  const mv = demoReply(demo.game);
  if (!mv) { demo.next = now + 1000; return; }
  demo.game.move(mv);
  demo.plays++;
  demo.next = now + 2400;
}

function demoReply(g) {
  const legal = g.moves({ verbose: true });
  if (!legal.length) return null;
  for (let i = 0; i < demo.replies.length; i++) {
    const want = demo.replies[(demo.reply + i) % demo.replies.length];
    const mv = legal.find((m) => m.san === want);
    if (mv) {
      demo.reply = (demo.reply + i + 1) % demo.replies.length;
      return mv;
    }
  }
  return legal[(demo.plays * 5) % legal.length];
}

function renderDemo(now) {
  maybeStepDemo(now);
  demo.scene.renderScene(ctx, {
    w: vw, h: vh, fen: demo.game.fen(), quad: demo.quad,
    border: 0.02, light: 0.05, noise: 4, seed: 7 + demo.plays,
  });
}

/**
 * Put the synthetic board back in step after Resync, Undo or a side change.
 * Without this the demo would keep the old position for up to a move's hold,
 * and the freshly reset reader would re-base on a board that is about to jump.
 */
function syncDemo() {
  if (!demo) return;
  demo.game.load(game.fen());
  demo.armed = 0;
  demo.next = 0;        // act on the very next frame
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
  ensureAdvice(performance.now());

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
  // Keep the confirmed position *and* the guidance as the reference and wait —
  // the move being played underneath the hand is read as soon as the board is
  // clear again. (Only after the change set has been stable for several seconds
  // does the reader insist on a re-baseline, which is what `stuck` means.)
  if (r.implausible && !r.stuck) {
    setStatus('Hand over the board — waiting for a clear view', '');
    return;
  }

  const out = coach.read(r.changed);
  reader.commit(desc);

  if (out.accepted) {
    desynced = false;
    const san = out.move.san;
    if (out.played) {
      // The arrow is already gone: coach.read() dropped it before returning.
      setStatus(`Played ${san} — waiting for ${coach.opponentName}`, 'ok');
    } else {
      setStatus(`Move read: ${san}`, 'ok');
    }
    askEngine();   // thinks only when it is our turn
    return;
  }

  // Nothing conclusive this time. The coach has dropped the recommendation, so
  // the arrow cannot linger on a position that has moved on; do not ask again
  // for the same position or it would simply come back.
  desynced = true;
  setStatus(r.stuck
    ? 'Board changed a lot — tap Resync if that was not a hand'
    : 'Could not read that move — tap Resync', 'bad');
  showBest();
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
  if (desynced) {
    setStatus('Could not read that move — tap Resync', 'bad');
    return;
  }
  if (game.game_over()) {
    setStatus(game.in_checkmate() ? 'Checkmate' : 'Draw', '');
    return;
  }
  if (coach.guidance) {
    setStatus(`Board locked · play ${coach.guidance.san} (${coach.sideName})`, 'ok');
    return;
  }
  if (coach.thinking) {
    setStatus('Board locked · thinking…', 'ok');
    return;
  }
  if (coach.myTurn) {
    setStatus(`Board locked · ${coach.sideName} to move`, 'ok');
    return;
  }
  setStatus(`Board locked · watching for ${coach.opponentName}'s move`, 'ok');
}

function setStatus(text, tone) {
  if (status.text === text) return;
  status = { text, tone };
  statusText.textContent = text;
  dot.className = tone || '';
  // keep transient messages on screen for a moment instead of letting the
  // idle status overwrite them on the next frame
  const transient = tone === 'bad' || text.startsWith('Move read') || text.startsWith('Played ');
  holdStatus = transient ? performance.now() + 2600 : 0;
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

  // `guidance` is null unless the recommendation belongs to the position on
  // the board right now and it is our turn — the single source of truth for
  // "should the arrow be visible".
  const g = coach.guidance;
  if (g && tracker.H) drawMove(tracker.H, g);
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

  // ring the square the piece starts on and the destination, so a long arrow
  // reads unambiguously at both ends
  ctx.lineWidth = Math.max(2, width * 0.35);
  ctx.strokeStyle = 'rgba(127, 240, 170, .35)';
  ringSquare(H, mv.from);
  ctx.strokeStyle = 'rgba(127, 240, 170, .6)';
  ringSquare(H, mv.to);
  ctx.restore();
}

/** Outline one square, following the perspective of the board. */
function ringSquare(H, square) {
  const f = 'abcdefgh'.indexOf(square[0]);
  const r = Number(square[1]) - 1;
  const pts = [[f + 0.13, r + 0.13], [f + 0.87, r + 0.13], [f + 0.87, r + 0.87], [f + 0.13, r + 0.87]]
    .map(([x, y]) => project(H, x, y));
  if (pts.some((p) => !p)) return;
  ctx.beginPath();
  pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
  ctx.closePath();
  ctx.stroke();
}

/* ------------------------------------------------------------------ */
/* controls                                                            */
/* ------------------------------------------------------------------ */

sideSel.addEventListener('change', () => {
  const side = sideSel.value;
  try { localStorage.setItem(SIDE_KEY, side); } catch { /* private mode */ }
  tracker = new BoardTracker({ side });
  coach.setSide(side);
  reader = new MoveReader();
  lastDesc = null;
  sampler.reset();
  desynced = false;
  lastAsk = 0;
  thinkingSince = 0;
  engineRetryAt = 0;
  engineError = '';
  if (demo) {
    // the demo scene must be seen from the side being played
    demo.quad = demo.scene.makePose(vw, vh, {
      tilt: 0.28, size: Math.min(vw, vh) * 0.86, flip: side === 'b',
    });
  }
  syncDemo();
  setStatus(`Switched to ${coach.sideName} — hold the board in view`, '');
  askEngine();
});

document.getElementById('resync').addEventListener('click', () => {
  coach.reset();
  reader = new MoveReader();
  lastDesc = null;
  sampler.reset();
  desynced = false;
  syncDemo();
  setStatus('Reset to the start position', 'ok');
  askEngine();
});

document.getElementById('undo').addEventListener('click', () => {
  if (coach.undo()) {
    reader = new MoveReader();
    lastDesc = null;
    sampler.reset();
    desynced = false;
    syncDemo();
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
  side: coach.side,
  turn: game.turn(),
  myTurn: coach.myTurn,
  thinking: coach.thinking,
  desynced,
  history: game.history(),
  suggestion: coach.guidance ? coach.guidance.san : null,
  pending: coach.suggestion ? coach.suggestion.san : null,
  req: coach.req,
  depth: engineDepth,
  nodes: engineNodes,
  eval: engineScore,
  engineError,
});
