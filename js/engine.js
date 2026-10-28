/*
 * engine.js — chess search running in a module worker.
 *
 * Alpha-beta with iterative deepening, MVV-LVA move ordering and a quiescence
 * search over captures, so the score it returns is not thrown off by a piece
 * hanging at the horizon. Deliberately small: this has to answer in well under
 * a second on a phone while the camera loop is running in the page.
 *
 * Protocol
 *   in : { type: 'think', fen, ms }      ms = time budget, default 1200
 *   out: { type: 'best', fen, from, to, promotion, san, score, depth, nodes, pv }
 *        { type: 'info', depth, score, nodes }   after each completed depth
 */

import { Chess } from '../vendor/chess.js';

const VALUE = { p: 100, n: 320, b: 330, r: 500, q: 900, k: 0 };
const MATE = 100000;

/* Piece-square tables, written from White's point of view with rank 8 first
   (the same order chess.js uses in `board()`), so no flipping is needed. */
const PST = {
  p: [
    0, 0, 0, 0, 0, 0, 0, 0,
    50, 50, 50, 50, 50, 50, 50, 50,
    10, 10, 20, 30, 30, 20, 10, 10,
    5, 5, 10, 25, 25, 10, 5, 5,
    0, 0, 0, 20, 20, 0, 0, 0,
    5, -5, -10, 0, 0, -10, -5, 5,
    5, 10, 10, -20, -20, 10, 10, 5,
    0, 0, 0, 0, 0, 0, 0, 0,
  ],
  n: [
    -50, -40, -30, -30, -30, -30, -40, -50,
    -40, -20, 0, 0, 0, 0, -20, -40,
    -30, 0, 10, 15, 15, 10, 0, -30,
    -30, 5, 15, 20, 20, 15, 5, -30,
    -30, 0, 15, 20, 20, 15, 0, -30,
    -30, 5, 10, 15, 15, 10, 5, -30,
    -40, -20, 0, 5, 5, 0, -20, -40,
    -50, -40, -30, -30, -30, -30, -40, -50,
  ],
  b: [
    -20, -10, -10, -10, -10, -10, -10, -20,
    -10, 0, 0, 0, 0, 0, 0, -10,
    -10, 0, 5, 10, 10, 5, 0, -10,
    -10, 5, 5, 10, 10, 5, 5, -10,
    -10, 0, 10, 10, 10, 10, 0, -10,
    -10, 10, 10, 10, 10, 10, 10, -10,
    -10, 5, 0, 0, 0, 0, 5, -10,
    -20, -10, -10, -10, -10, -10, -10, -20,
  ],
  r: [
    0, 0, 0, 0, 0, 0, 0, 0,
    5, 10, 10, 10, 10, 10, 10, 5,
    -5, 0, 0, 0, 0, 0, 0, -5,
    -5, 0, 0, 0, 0, 0, 0, -5,
    -5, 0, 0, 0, 0, 0, 0, -5,
    -5, 0, 0, 0, 0, 0, 0, -5,
    -5, 0, 0, 0, 0, 0, 0, -5,
    0, 0, 0, 5, 5, 0, 0, 0,
  ],
  q: [
    -20, -10, -10, -5, -5, -10, -10, -20,
    -10, 0, 0, 0, 0, 0, 0, -10,
    -10, 0, 5, 5, 5, 5, 0, -10,
    -5, 0, 5, 5, 5, 5, 0, -5,
    0, 0, 5, 5, 5, 5, 0, -5,
    -10, 5, 5, 5, 5, 5, 0, -10,
    -10, 0, 5, 0, 0, 0, 0, -10,
    -20, -10, -10, -5, -5, -10, -10, -20,
  ],
  k: [
    -30, -40, -40, -50, -50, -40, -40, -30,
    -30, -40, -40, -50, -50, -40, -40, -30,
    -30, -40, -40, -50, -50, -40, -40, -30,
    -30, -40, -40, -50, -50, -40, -40, -30,
    -20, -30, -30, -40, -40, -30, -30, -20,
    -10, -20, -20, -20, -20, -20, -20, -10,
    20, 20, 0, 0, 0, 0, 20, 20,
    20, 30, 10, 0, 0, 10, 30, 20,
  ],
};

/* Mirrored table index for Black, whose board rows run the other way. */
function pstIndex(type, color, row, col) {
  return color === 'w' ? row * 8 + col : (7 - row) * 8 + col;
}

function evaluate(game) {
  const board = game.board();
  let score = 0;
  for (let row = 0; row < 8; row++) {
    for (let col = 0; col < 8; col++) {
      const sq = board[row][col];
      if (!sq) continue;
      const base = VALUE[sq.type] + PST[sq.type][pstIndex(sq.type, sq.color, row, col)];
      score += sq.color === 'w' ? base : -base;
    }
  }
  return game.turn() === 'w' ? score : -score;
}

let nodes = 0;
let deadline = 0;
let aborted = false;

function timeUp() {
  if ((nodes & 511) === 0 && performance.now() > deadline) aborted = true;
  return aborted;
}

/** Captures first, biggest victim taken by the cheapest attacker. */
function orderMoves(moves) {
  const scored = moves.map((m) => {
    let s = 0;
    if (m.captured) s += 1000 + VALUE[m.captured] - VALUE[m.piece] / 10;
    if (m.promotion) s += 800 + VALUE[m.promotion];
    if (m.san.includes('#')) s += 5000;
    else if (m.san.includes('+')) s += 60;
    return { m, s };
  });
  scored.sort((a, b) => b.s - a.s);
  return scored.map((x) => x.m);
}

function quiesce(game, alpha, beta, ply) {
  nodes++;
  if (timeUp()) return alpha;
  const stand = evaluate(game);
  if (stand >= beta) return beta;
  if (stand > alpha) alpha = stand;

  const caps = game.moves({ verbose: true }).filter((m) => m.captured || m.promotion);
  if (!caps.length) return alpha;

  for (const m of orderMoves(caps)) {
    game.move(m);
    const v = -quiesce(game, -beta, -alpha, ply + 1);
    game.undo();
    if (aborted) return alpha;
    if (v >= beta) return beta;
    if (v > alpha) alpha = v;
  }
  return alpha;
}

function search(game, depth, alpha, beta, ply) {
  nodes++;
  if (timeUp()) return alpha;

  const moves = game.moves({ verbose: true });
  if (!moves.length) return game.in_check() ? -MATE + ply : 0;
  if (depth <= 0) return quiesce(game, alpha, beta, ply);

  let best = alpha;
  for (const m of orderMoves(moves)) {
    game.move(m);
    const v = -search(game, depth - 1, -beta, -best, ply + 1);
    game.undo();
    if (aborted) return best;
    if (v > best) {
      best = v;
      if (v >= beta) break;
    }
  }
  return best;
}

/** One full root pass; returns the best move and its score. */
function rootSearch(game, depth) {
  const moves = orderMoves(game.moves({ verbose: true }));
  let best = null, bestScore = -Infinity;
  for (const m of moves) {
    game.move(m);
    // alpha = -Infinity, beta = -bestScore: later moves only need to prove they
    // are worse than the current leader
    const v = -search(game, depth - 1, -Infinity, -bestScore, 1);
    game.undo();
    if (aborted) break;
    if (v > bestScore) {
      bestScore = v;
      best = m;
    }
  }
  return { best, score: bestScore };
}

self.onmessage = (e) => {
  const msg = e.data;
  if (msg.type !== 'think') return;

  const game = new Chess();
  try {
    game.load(msg.fen);
  } catch {
    self.postMessage({ type: 'error', fen: msg.fen, error: 'bad fen' });
    return;
  }

  const budget = msg.ms || 1200;
  const start = performance.now();
  deadline = start + budget;
  nodes = 0;
  aborted = false;

  let best = null, score = 0, reached = 0;
  for (let depth = 1; depth <= (msg.maxDepth || 6); depth++) {
    const r = rootSearch(game, depth);
    if (r.best) { best = r.best; score = r.score; reached = depth; }
    if (aborted) break;
    self.postMessage({ type: 'info', depth, score, nodes });
    // only start another ply if the budget is likely to cover it
    const spent = performance.now() - start;
    if (spent > budget * 0.45) break;
  }

  if (!best) {
    self.postMessage({ type: 'best', fen: msg.fen, from: null, to: null, score: 0, depth: 0, nodes });
    return;
  }
  self.postMessage({
    type: 'best',
    fen: msg.fen,
    from: best.from,
    to: best.to,
    promotion: best.promotion || null,
    san: best.san,
    score,
    depth: reached,
    nodes,
  });
};
