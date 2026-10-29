/*
 * engine-search.js — alpha-beta over the 0x88 board.
 *
 * The shape of the search is deliberately conventional; what matters is that
 * every part is cheap enough that a ~2 s budget buys a meaningful depth:
 *
 *   iterative deepening -> PVS -> transposition table -> killer/history
 *   ordering -> null-move pruning -> reverse futility -> late-move reductions
 *   -> quiescence with delta pruning.
 *
 * Scores are from the side to move at the root, in centipawns. Mate scores are
 * `MATE - ply`, so a shorter mate is always preferred and a transposition table
 * hit can be corrected for the ply at which it is reused.
 */

import {
  WHITE, BLACK, PAWN, KNIGHT, BISHOP, ROOK, QUEEN, KING,
  MATE, INF, MAX_PLY, MAX_MOVES, F_CASTLE,
  board, turn, halfmove, hashLo, hashHi, ply, moveBuf,
  loadFen, generate, isLegal, makeMove, unmakeMove, makeNull, unmakeNull,
  hasNonPawn, inCheck, mCap, mPromo, mFrom, mTo, mFlags, moveToUci,
} from './engine-board.js';
import { evaluate } from './engine-eval.js';

const MATE_BOUND = MATE - 1000;
const PIECE_VALUE = [0, 100, 320, 330, 500, 900, 0];

/* ------------------------------------------------------------------ */
/* transposition table                                                 */
/* ------------------------------------------------------------------ */

const TT_BITS = 19;
const TT_SIZE = 1 << TT_BITS;
const TT_MASK = TT_SIZE - 1;
const ttKey = new Int32Array(TT_SIZE);
const ttMove = new Int32Array(TT_SIZE);
const ttScore = new Int32Array(TT_SIZE);
const ttDepth = new Int8Array(TT_SIZE);
const ttFlag = new Uint8Array(TT_SIZE); // 1 exact, 2 lower, 3 upper

/* ------------------------------------------------------------------ */
/* ordering                                                            */
/* ------------------------------------------------------------------ */

const killer1 = new Int32Array(MAX_PLY + 8);
const killer2 = new Int32Array(MAX_PLY + 8);
const history = new Int32Array(2 * 128 * 128);
const moveScores = new Int32Array((MAX_PLY + 8) * MAX_MOVES);

/* positions on the current search path, for repetition detection */
const pathLo = new Int32Array(MAX_PLY + 8);
const pathHi = new Int32Array(MAX_PLY + 8);

let nodes = 0;
let deadline = 0;
let aborted = false;

function tick() {
  nodes++;
  if ((nodes & 1023) === 0 && performance.now() >= deadline) aborted = true;
}

function isRepetition() {
  for (let i = ply - 2; i >= 0; i -= 2) {
    if (pathLo[i] === hashLo && pathHi[i] === hashHi) return true;
  }
  return false;
}

function scoreMoves(base, n, ttM, atPly) {
  const us = turn;
  for (let i = 0; i < n; i++) {
    const m = moveBuf[base + i];
    let s;
    if (m === ttM) {
      s = 1_000_000_000;
    } else {
      const cap = mCap(m);
      const promo = mPromo(m);
      if (cap) {
        s = 1_000_000 + PIECE_VALUE[cap] * 16 - PIECE_VALUE[board[mFrom(m)] & 7] / 8;
        if (promo) s += 20_000_000 + PIECE_VALUE[promo];
      } else if (promo) {
        s = 20_000_000 + PIECE_VALUE[promo];
      } else if (m === killer1[atPly]) {
        s = 900_000;
      } else if (m === killer2[atPly]) {
        s = 800_000;
      } else {
        s = history[(us << 14) | (mFrom(m) << 7) | mTo(m)];
        if (s > 700_000) s = 700_000;
      }
    }
    moveScores[base + i] = s;
  }
}

/** Selection sort one move to the front; cheaper than sorting the whole list. */
function pickMove(base, n, i) {
  let bi = i;
  for (let j = i + 1; j < n; j++) {
    if (moveScores[base + j] > moveScores[base + bi]) bi = j;
  }
  if (bi !== i) {
    const m = moveBuf[base + i]; moveBuf[base + i] = moveBuf[base + bi]; moveBuf[base + bi] = m;
    const s = moveScores[base + i]; moveScores[base + i] = moveScores[base + bi]; moveScores[base + bi] = s;
  }
  return moveBuf[base + i];
}

function bonusHistory(us, m, depth) {
  const idx = (us << 14) | (mFrom(m) << 7) | mTo(m);
  const v = history[idx] + depth * depth;
  history[idx] = v > 1_000_000 ? 1_000_000 : v;
}

/* ------------------------------------------------------------------ */
/* transposition table helpers                                         */
/* ------------------------------------------------------------------ */

function probe(depth, alpha, beta, atPly) {
  const idx = hashLo & TT_MASK;
  if (!ttFlag[idx] || ttKey[idx] !== hashHi) return null;
  const best = ttMove[idx];
  if (ttDepth[idx] < depth) return { move: best, score: 0, usable: false };
  let s = ttScore[idx];
  if (s > MATE_BOUND) s -= atPly;
  else if (s < -MATE_BOUND) s += atPly;
  const f = ttFlag[idx];
  if (f === 1) return { move: best, score: s, usable: true };
  if (f === 2 && s >= beta) return { move: best, score: s, usable: true };
  if (f === 3 && s <= alpha) return { move: best, score: s, usable: true };
  return { move: best, score: s, usable: false };
}

function store(depth, score, flag, move, atPly) {
  const idx = hashLo & TT_MASK;
  if (ttFlag[idx] && ttKey[idx] !== hashHi && ttDepth[idx] > depth + 2) return;
  let s = score;
  if (s > MATE_BOUND) s += atPly;
  else if (s < -MATE_BOUND) s -= atPly;
  ttKey[idx] = hashHi;
  ttMove[idx] = move;
  ttScore[idx] = s;
  ttDepth[idx] = depth;
  ttFlag[idx] = flag;
}

/* ------------------------------------------------------------------ */
/* quiescence                                                          */
/* ------------------------------------------------------------------ */

function quiesce(alpha, beta) {
  tick();
  if (aborted) return alpha;
  if (ply >= MAX_PLY - 2) return evaluate();

  const checked = inCheck(turn);
  let stand = 0;
  let best;
  if (!checked) {
    stand = evaluate();
    if (stand >= beta) return stand;
    if (stand > alpha) alpha = stand;
    best = stand;
  } else {
    best = -INF;
  }

  const base = ply * MAX_MOVES;
  const n = generate(turn, !checked, moveBuf, base);
  scoreMoves(base, n, 0, ply);

  for (let i = 0; i < n; i++) {
    const m = pickMove(base, n, i);
    if (!isLegal(m, turn)) continue;

    // Delta pruning: a capture that cannot recover the distance to alpha even
    // with a generous margin is not worth searching. Promotions are kept, and
    // evasions are never pruned.
    if (!checked && !mPromo(m) && stand + PIECE_VALUE[mCap(m)] + 150 < alpha) continue;

    makeMove(m);
    const v = -quiesce(-beta, -alpha);
    unmakeMove();
    if (aborted) return best > -INF ? best : alpha;
    if (v > best) {
      best = v;
      if (v > alpha) {
        alpha = v;
        if (v >= beta) return v;
      }
    }
  }

  if (checked && best === -INF) return -MATE + ply;
  return best;
}

/* ------------------------------------------------------------------ */
/* main search                                                         */
/* ------------------------------------------------------------------ */

function search(depth, alpha, beta, allowNull) {
  tick();
  if (aborted) return alpha;
  if (ply >= MAX_PLY - 2) return evaluate();

  if (ply > 0) {
    if (halfmove >= 100) return 0;
    if (isRepetition()) return 0;
  }

  // mate-distance pruning
  const low = -MATE + ply;
  const high = MATE - ply - 1;
  if (alpha < low) alpha = low;
  if (beta > high) beta = high;
  if (alpha >= beta) return alpha;

  const t = probe(depth, alpha, beta, ply);
  const ttM = t ? t.move : 0;
  if (t && t.usable) return t.score;

  const checked = inCheck(turn);
  if (checked && ply < 60) depth++;
  if (depth <= 0) return quiesce(alpha, beta);

  let staticEval = 0;
  if (!checked) {
    staticEval = evaluate();
    // Reverse futility: at shallow depths a position this far above beta is
    // almost always a cutoff, and evaluating it is cheaper than searching it.
    if (depth <= 4 && beta < MATE_BOUND && staticEval - 90 * depth >= beta) {
      return staticEval;
    }
    if (allowNull && depth >= 3 && beta < MATE_BOUND &&
        staticEval >= beta && hasNonPawn(turn)) {
      makeNull();
      pathLo[ply] = hashLo;
      pathHi[ply] = hashHi;
      const v = -search(depth - 3, -beta, -beta + 1, false);
      unmakeNull();
      if (aborted) return alpha;
      if (v >= beta) return v;
    }
  }

  const base = ply * MAX_MOVES;
  const n = generate(turn, false, moveBuf, base);
  scoreMoves(base, n, ttM, ply);

  const alphaOrig = alpha;
  let best = -INF;
  let bestMove = 0;
  let legal = 0;

  for (let i = 0; i < n; i++) {
    const m = pickMove(base, n, i);
    if (!isLegal(m, turn)) continue;
    legal++;

    const quiet = !mCap(m) && !mPromo(m);
    const us = turn;
    makeMove(m);
    pathLo[ply] = hashLo;
    pathHi[ply] = hashHi;

    let v;
    if (legal === 1) {
      v = -search(depth - 1, -beta, -alpha, true);
    } else {
      let reduction = 0;
      if (depth >= 3 && legal > 3 && quiet && !checked) {
        reduction = 1;
        if (depth >= 5 && legal > 6) reduction = 2;
      }
      v = -search(depth - 1 - reduction, -alpha - 1, -alpha, true);
      if (v > alpha && reduction) v = -search(depth - 1, -alpha - 1, -alpha, true);
      if (v > alpha && v < beta) v = -search(depth - 1, -beta, -alpha, true);
    }

    unmakeMove();
    if (aborted) return best > -INF ? best : alpha;

    if (v > best) {
      best = v;
      bestMove = m;
      if (v > alpha) {
        alpha = v;
        if (alpha >= beta) {
          if (quiet) {
            if (killer1[ply] !== m) {
              killer2[ply] = killer1[ply];
              killer1[ply] = m;
            }
            bonusHistory(us, m, depth);
          }
          break;
        }
      }
    }
  }

  if (!legal) return checked ? -MATE + ply : 0;

  const flag = best >= beta ? 2 : best > alphaOrig ? 1 : 3;
  store(depth, best, flag, bestMove, ply);
  return best;
}

/* ------------------------------------------------------------------ */
/* root                                                                */
/* ------------------------------------------------------------------ */

function rootSearch(depth, alpha, beta, preferred) {
  const base = 0;
  const n = generate(turn, false, moveBuf, base);
  scoreMoves(base, n, preferred || 0, 0);

  let best = 0, bestScore = -INF, legal = 0;
  let complete = true;

  for (let i = 0; i < n; i++) {
    const m = pickMove(base, n, i);
    if (!isLegal(m, turn)) continue;
    legal++;

    makeMove(m);
    pathLo[1] = hashLo;
    pathHi[1] = hashHi;

    let v;
    if (legal === 1) {
      v = -search(depth - 1, -beta, -alpha, true);
    } else {
      v = -search(depth - 1, -alpha - 1, -alpha, true);
      if (v > alpha && v < beta) v = -search(depth - 1, -beta, -alpha, true);
    }

    unmakeMove();
    if (aborted) { complete = false; break; }

    if (v > bestScore) {
      bestScore = v;
      best = m;
      if (v > alpha) alpha = v;
    }
  }

  return { move: best, score: bestScore, legal, complete };
}

function extractPv() {
  const out = [];
  let made = 0;
  for (let i = 0; i < 12; i++) {
    const idx = hashLo & TT_MASK;
    if (!ttFlag[idx] || ttKey[idx] !== hashHi) break;
    const m = ttMove[idx];
    if (!m) break;
    if (!isLegal(m, turn)) break;
    out.push(moveToUci(m));
    makeMove(m);
    made++;
  }
  for (let i = 0; i < made; i++) unmakeMove();
  return out;
}

/**
 * Search `fen` for at most `ms` milliseconds.
 *
 * Returns `{ from, to, promotion, score, depth, nodes, pv }` in 0x88 terms, or
 * `null` when the side to move has no legal move. `onInfo` is called after
 * each completed depth.
 */
export function searchPosition(fen, { ms = 1500, maxDepth = 64, onInfo = null } = {}) {
  loadFen(fen);
  const start = performance.now();
  const budget = Math.max(30, ms | 0);
  deadline = start + budget;
  nodes = 0;
  aborted = false;

  killer1.fill(0);
  killer2.fill(0);
  for (let i = 0; i < history.length; i++) history[i] >>= 1;
  ttFlag.fill(0);   // the rest of an entry is ignored while its flag is 0

  pathLo[0] = hashLo;
  pathHi[0] = hashHi;

  let bestMove = 0, bestScore = 0, reached = 0;
  let prev = 0;

  for (let depth = 1; depth <= maxDepth; depth++) {
    let a = -INF, b = INF;
    if (depth >= 3 && Math.abs(prev) < MATE_BOUND) {
      a = prev - 45;
      b = prev + 45;
    }

    let r = rootSearch(depth, a, b, bestMove);
    let accept = r.move !== 0;

    if (r.complete && depth >= 3 && Math.abs(r.score) < MATE_BOUND &&
        (r.score <= a || r.score >= b)) {
      const full = rootSearch(depth, -INF, INF, r.move);
      if (full.move) { r = full; accept = true; } else accept = false;
    }

    if (!r.complete) break;

    if (accept) {
      bestMove = r.move;
      bestScore = r.score;
      reached = depth;
      prev = r.score;
    }

    // Put the root in the table as well: it is what extractPv walks, and it
    // lets the next iteration order the previous best first.
    store(reached, bestScore, 1, bestMove, 0);

    if (onInfo) {
      onInfo({ depth, score: bestScore, nodes, pv: extractPv() });
    }
    if (Math.abs(bestScore) > MATE_BOUND) break;
    if (performance.now() - start > budget * 0.55) break;
  }

  if (!bestMove) return null;

  // The accepted move may come from an iteration that was cut off before it
  // could store its own root entry; write it now so the PV starts with it.
  store(reached, bestScore, 1, bestMove, 0);

  return {
    from: mFrom(bestMove),
    to: mTo(bestMove),
    promotion: mPromo(bestMove) || 0,
    castle: (mFlags(bestMove) & F_CASTLE) !== 0,
    score: bestScore,
    depth: reached,
    nodes,
    pv: extractPv(),
  };
}

/**
 * Score every legal root move independently, for tuning and tests.
 * Each move gets a fresh table and a full window, so the scores are comparable
 * instead of being affected by earlier moves' cutoffs.
 */
export function rootMoveScores(fen, { depth = 6, ms = 10000 } = {}) {
  loadFen(fen);
  const start = performance.now();
  deadline = start + ms;
  nodes = 0;
  aborted = false;
  pathLo[0] = hashLo;
  pathHi[0] = hashHi;

  const legal = [];
  const n = generate(turn, false, moveBuf, 0);
  for (let i = 0; i < n; i++) {
    const m = moveBuf[i];
    if (isLegal(m, turn)) legal.push(m);
  }

  const out = [];
  for (const m of legal) {
    if (aborted || performance.now() >= deadline) break;
    ttFlag.fill(0);
    killer1.fill(0);
    killer2.fill(0);
    makeMove(m);
    pathLo[1] = hashLo;
    pathHi[1] = hashHi;
    const v = -search(depth - 1, -INF, INF, true);
    unmakeMove();
    out.push({ uci: moveToUci(m), score: v });
  }
  out.sort((a, b) => b.score - a.score);
  return out;
}
