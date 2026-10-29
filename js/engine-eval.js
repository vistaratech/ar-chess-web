/*
 * engine-eval.js — static evaluation.
 *
 * Tapered: a middlegame score and an endgame score are computed together and
 * blended by how much material is left. The piece-square tables are written
 * with a8 first (the same order the engine's square mapping produces), so a
 * White piece at 0x88 square `sq` uses `(7 - rank) * 8 + file` and a Black one
 * uses `rank * 8 + file`. That is the mirror that makes one table work for both
 * colours.
 *
 * Beyond material and placement the score includes the things that decide real
 * games: the bishop pair, doubled/isolated/passed pawns, rooks on open and
 * semi-open files and on the seventh, a simple pawn shield in front of the
 * king, and a tempo bonus for the side to move. It is deliberately cheap: it
 * runs at every leaf and in quiescence, so every term is a few arithmetic
 * operations over a 0x88 scan that is already being made for the material.
 */

import {
  WHITE, BLACK, PAWN, KNIGHT, BISHOP, ROOK, QUEEN, KING,
  board, kingSq, turn,
} from './engine-board.js';

const VAL = [0, 100, 320, 330, 500, 900, 0];
const PHASE_W = [0, 0, 1, 1, 2, 4, 0];
const MAX_PHASE = 24;

/* middlegame tables (a8 first) */
const MG = {
  [PAWN]: [
    0, 0, 0, 0, 0, 0, 0, 0,
    50, 50, 50, 50, 50, 50, 50, 50,
    10, 10, 20, 30, 30, 20, 10, 10,
    5, 5, 10, 25, 25, 10, 5, 5,
    0, 0, 0, 20, 20, 0, 0, 0,
    5, -5, -10, 0, 0, -10, -5, 5,
    5, 10, 10, -20, -20, 10, 10, 5,
    0, 0, 0, 0, 0, 0, 0, 0,
  ],
  [KNIGHT]: [
    -50, -40, -30, -30, -30, -30, -40, -50,
    -40, -20, 0, 0, 0, 0, -20, -40,
    -30, 0, 10, 15, 15, 10, 0, -30,
    -30, 5, 15, 20, 20, 15, 5, -30,
    -30, 0, 15, 20, 20, 15, 0, -30,
    -30, 5, 10, 15, 15, 10, 5, -30,
    -40, -20, 0, 5, 5, 0, -20, -40,
    -50, -40, -30, -30, -30, -30, -40, -50,
  ],
  [BISHOP]: [
    -20, -10, -10, -10, -10, -10, -10, -20,
    -10, 0, 0, 0, 0, 0, 0, -10,
    -10, 0, 5, 10, 10, 5, 0, -10,
    -10, 5, 5, 10, 10, 5, 5, -10,
    -10, 0, 10, 10, 10, 10, 0, -10,
    -10, 10, 10, 10, 10, 10, 10, -10,
    -10, 5, 0, 0, 0, 0, 5, -10,
    -20, -10, -10, -10, -10, -10, -10, -20,
  ],
  [ROOK]: [
    0, 0, 0, 0, 0, 0, 0, 0,
    5, 10, 10, 10, 10, 10, 10, 5,
    -5, 0, 0, 0, 0, 0, 0, -5,
    -5, 0, 0, 0, 0, 0, 0, -5,
    -5, 0, 0, 0, 0, 0, 0, -5,
    -5, 0, 0, 0, 0, 0, 0, -5,
    -5, 0, 0, 0, 0, 0, 0, -5,
    0, 0, 0, 5, 5, 0, 0, 0,
  ],
  [QUEEN]: [
    -20, -10, -10, -5, -5, -10, -10, -20,
    -10, 0, 0, 0, 0, 0, 0, -10,
    -10, 0, 5, 5, 5, 5, 0, -10,
    -5, 0, 5, 5, 5, 5, 0, -5,
    0, 0, 5, 5, 5, 5, 0, -5,
    -10, 5, 5, 5, 5, 5, 0, -10,
    -10, 0, 5, 0, 0, 0, 0, -10,
    -20, -10, -10, -5, -5, -10, -10, -20,
  ],
  [KING]: [
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

/* endgame tables: knights/bishops/queens keep their shape, the king comes out */
const EG = {
  [PAWN]: [
    0, 0, 0, 0, 0, 0, 0, 0,
    90, 90, 90, 90, 90, 90, 90, 90,
    55, 55, 55, 55, 55, 55, 55, 55,
    32, 32, 32, 32, 32, 32, 32, 32,
    18, 18, 18, 18, 18, 18, 18, 18,
    8, 8, 8, 8, 8, 8, 8, 8,
    0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0,
  ],
  [KNIGHT]: [
    -50, -40, -30, -30, -30, -30, -40, -50,
    -40, -20, 0, 0, 0, 0, -20, -40,
    -30, 0, 10, 15, 15, 10, 0, -30,
    -30, 5, 15, 20, 20, 15, 5, -30,
    -30, 0, 15, 20, 20, 15, 0, -30,
    -30, 5, 10, 15, 15, 10, 5, -30,
    -40, -20, 0, 5, 5, 0, -20, -40,
    -50, -40, -30, -30, -30, -30, -40, -50,
  ],
  [BISHOP]: [
    -16, -8, -8, -8, -8, -8, -8, -16,
    -8, 0, 0, 0, 0, 0, 0, -8,
    -8, 0, 6, 10, 10, 6, 0, -8,
    -8, 4, 6, 12, 12, 6, 4, -8,
    -8, 0, 10, 12, 12, 10, 0, -8,
    -8, 6, 6, 10, 10, 6, 6, -8,
    -8, 4, 0, 0, 0, 0, 4, -8,
    -16, -8, -8, -8, -8, -8, -8, -16,
  ],
  [ROOK]: [
    0, 0, 0, 0, 0, 0, 0, 0,
    12, 14, 14, 14, 14, 14, 14, 12,
    6, 8, 8, 8, 8, 8, 8, 6,
    2, 4, 4, 4, 4, 4, 4, 2,
    0, 2, 2, 2, 2, 2, 2, 0,
    -2, 0, 0, 0, 0, 0, 0, -2,
    -4, -2, 0, 0, 0, 0, -2, -4,
    0, 0, 0, 4, 4, 0, 0, 0,
  ],
  [QUEEN]: [
    -16, -8, -8, -4, -4, -8, -8, -16,
    -8, 0, 0, 0, 0, 0, 0, -8,
    -8, 0, 6, 6, 6, 6, 0, -8,
    -4, 0, 6, 8, 8, 6, 0, -4,
    -4, 0, 6, 8, 8, 6, 0, -4,
    -8, 4, 6, 6, 6, 6, 4, -8,
    -8, 0, 4, 0, 0, 4, 0, -8,
    -16, -8, -8, -4, -4, -8, -8, -16,
  ],
  [KING]: [
    -50, -40, -30, -20, -20, -30, -40, -50,
    -30, -20, -10, 0, 0, -10, -20, -30,
    -30, -10, 20, 30, 30, 20, -10, -30,
    -30, -10, 30, 40, 40, 30, -10, -30,
    -30, -10, 30, 40, 40, 30, -10, -30,
    -30, -10, 20, 30, 30, 20, -10, -30,
    -30, -30, 0, 0, 0, 0, -30, -30,
    -50, -30, -30, -30, -30, -30, -30, -50,
  ],
};

const PASSED_MG = [0, 5, 10, 20, 35, 60, 100, 0];
const PASSED_EG = [0, 8, 16, 30, 55, 90, 150, 0];

const MOB_MG = [0, 0, 4, 3, 2, 1, 0];
const MOB_EG = [0, 0, 3, 2, 1, 1, 0];

const KNIGHT_DIRS = [-33, -31, -18, -14, 14, 18, 31, 33];
const BISHOP_DIRS = [-17, -15, 15, 17];
const ROOK_DIRS = [-16, -1, 1, 16];
const onBoard = (sq) => (sq & 0x88) === 0;

function mobility(type, sq, color) {
  let n = 0;
  if (type === KNIGHT) {
    for (let i = 0; i < 8; i++) {
      const to = sq + KNIGHT_DIRS[i];
      if (!onBoard(to)) continue;
      const q = board[to];
      if (!q || (q >> 3) !== color) n++;
    }
    return n;
  }

  const first = type === BISHOP ? BISHOP_DIRS : type === ROOK ? ROOK_DIRS : BISHOP_DIRS;
  const second = type === QUEEN ? ROOK_DIRS : null;
  for (let pass = 0; pass < (second ? 2 : 1); pass++) {
    const dirs = pass === 0 ? first : second;
    for (let i = 0; i < 4; i++) {
      const d = dirs[i];
      let to = sq + d;
      while (onBoard(to)) {
        const q = board[to];
        if (!q) {
          n++;
        } else {
          if ((q >> 3) !== color) n++;
          break;
        }
        to += d;
      }
    }
  }
  return n;
}

const pawnCount = [new Int32Array(8), new Int32Array(8)];
const rankMax = [new Int32Array(8), new Int32Array(8)];
const rankMin = [new Int32Array(8), new Int32Array(8)];
const wRookSquares = new Int32Array(10);
const bRookSquares = new Int32Array(10);

/**
 * Static score, from the side to move's point of view. Positive is good for
 * the side whose turn it is, which is what alpha-beta wants.
 */
export function evaluate() {
  let mg = 0, eg = 0, phase = 0;
  let wBishops = 0, bBishops = 0;
  let wRooks = 0, bRooks = 0;

  pawnCount[0].fill(0); pawnCount[1].fill(0);
  rankMax[0].fill(-1); rankMax[1].fill(-1);
  rankMin[0].fill(8); rankMin[1].fill(8);

  for (let r = 0; r < 8; r++) {
    for (let f = 0; f < 8; f++) {
      const sq = r * 16 + f;
      const p = board[sq];
      if (!p) continue;
      const type = p & 7;
      const color = p >> 3;
      const idx = color === WHITE ? (7 - r) * 8 + f : r * 8 + f;
      const sign = color === WHITE ? 1 : -1;

      mg += sign * (VAL[type] + MG[type][idx]);
      eg += sign * (VAL[type] + EG[type][idx]);

      if (type === PAWN) {
        pawnCount[color][f]++;
        if (r > rankMax[color][f]) rankMax[color][f] = r;
        if (r < rankMin[color][f]) rankMin[color][f] = r;
      } else if (type !== KING) {
        phase += PHASE_W[type];
        if (type === BISHOP) { if (color === WHITE) wBishops++; else bBishops++; }
        if (type === ROOK) {
          if (color === WHITE) { if (wRooks < 10) wRookSquares[wRooks] = sq; wRooks++; }
          else { if (bRooks < 10) bRookSquares[bRooks] = sq; bRooks++; }
        }
        const mob = mobility(type, sq, color);
        mg += sign * MOB_MG[type] * mob;
        eg += sign * MOB_EG[type] * mob;
      }
    }
  }

  if (wBishops >= 2) { mg += 25; eg += 40; }
  if (bBishops >= 2) { mg -= 25; eg -= 40; }

  // pawn structure
  for (let f = 0; f < 8; f++) {
    const wc = pawnCount[WHITE][f], bc = pawnCount[BLACK][f];
    if (wc > 1) { const d = (wc - 1); mg -= 10 * d; eg -= 16 * d; }
    if (bc > 1) { const d = (bc - 1); mg -= 10 * d; eg -= 16 * d; }
    if (wc && !(f > 0 && pawnCount[WHITE][f - 1]) && !(f < 7 && pawnCount[WHITE][f + 1])) {
      mg -= 10 * wc; eg -= 14 * wc;
    }
    if (bc && !(f > 0 && pawnCount[BLACK][f - 1]) && !(f < 7 && pawnCount[BLACK][f + 1])) {
      mg -= 10 * bc; eg -= 14 * bc;
    }
  }

  // passed pawns: no enemy pawn on this file or an adjacent one, ahead
  for (let r = 0; r < 8; r++) {
    for (let f = 0; f < 8; f++) {
      if (board[r * 16 + f] !== (WHITE << 3 | PAWN)) continue;
      let passed = true;
      for (let df = -1; df <= 1; df++) {
        const af = f + df;
        if (af < 0 || af > 7) continue;
        if (rankMax[BLACK][af] > r) { passed = false; break; }
      }
      if (passed) { mg += PASSED_MG[r]; eg += PASSED_EG[r]; }
    }
  }
  for (let r = 0; r < 8; r++) {
    for (let f = 0; f < 8; f++) {
      if (board[r * 16 + f] !== (BLACK << 3 | PAWN)) continue;
      let passed = true;
      for (let df = -1; df <= 1; df++) {
        const af = f + df;
        if (af < 0 || af > 7) continue;
        if (rankMin[WHITE][af] < r) { passed = false; break; }
      }
      if (passed) { const adv = 7 - r; mg -= PASSED_MG[adv]; eg -= PASSED_EG[adv]; }
    }
  }

  // rooks on files and on the seventh
  for (let i = 0; i < wRooks && i < 10; i++) {
    const sq = wRookSquares[i];
    const f = sq & 7, r = sq >> 4;
    if (!pawnCount[WHITE][f] && !pawnCount[BLACK][f]) { mg += 18; eg += 10; }
    else if (!pawnCount[WHITE][f]) { mg += 9; eg += 5; }
    if (r === 6) { mg += 16; eg += 10; }
  }
  for (let i = 0; i < bRooks && i < 10; i++) {
    const sq = bRookSquares[i];
    const f = sq & 7, r = sq >> 4;
    if (!pawnCount[WHITE][f] && !pawnCount[BLACK][f]) { mg -= 18; eg -= 10; }
    else if (!pawnCount[BLACK][f]) { mg -= 9; eg -= 5; }
    if (r === 1) { mg -= 16; eg -= 10; }
  }

  // a simple pawn shield: own pawns on the three files in front of the king
  for (let color = WHITE; color <= BLACK; color++) {
    const ksq = kingSq[color];
    const kf = ksq & 7, kr = ksq >> 4;
    const dir = color === WHITE ? 1 : -1;
    const sign = color === WHITE ? 1 : -1;
    let shield = 0;
    for (let df = -1; df <= 1; df++) {
      const f = kf + df;
      if (f < 0 || f > 7) continue;
      for (let step = 1; step <= 2; step++) {
        const r = kr + dir * step;
        if (r < 0 || r > 7) continue;
        if (board[r * 16 + f] === (color << 3 | PAWN)) { shield++; break; }
      }
    }
    if (!pawnCount[color][kf]) { mg -= sign * 18; eg -= sign * 6; }
    mg += sign * 8 * shield;
  }

  // tempo
  const score = phase >= MAX_PHASE
    ? mg
    : phase <= 0
      ? eg
      : Math.round((mg * phase + eg * (MAX_PHASE - phase)) / MAX_PHASE);
  const fromSide = turn === WHITE ? score : -score;
  return fromSide + 10;
}
