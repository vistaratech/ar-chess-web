/*
 * track.js — turn a set of changed board squares into a chess move.
 *
 * Square indices are rank-major: 0 = a1, 7 = h1, 8 = a2, ... 63 = h8.
 */

import { squareDiff, median } from './vision.js';

const FILES = 'abcdefgh';

export function squareIndex(sq) {
  return (Number(sq[1]) - 1) * 8 + FILES.indexOf(sq[0]);
}


export function indexSquare(i) {
  return FILES[i % 8] + (Math.floor(i / 8) + 1);
}

/** Every square whose appearance a move changes. */
export function moveSquares(m) {
  const set = new Set([squareIndex(m.from), squareIndex(m.to)]);
  const rank = m.color === 'w' ? '1' : '8';
  if (m.flags.includes('k')) { set.add(squareIndex('h' + rank)); set.add(squareIndex('f' + rank)); }
  if (m.flags.includes('q')) { set.add(squareIndex('a' + rank)); set.add(squareIndex('d' + rank)); }
  if (m.flags.includes('e')) set.add(squareIndex(m.to[0] + m.from[1]));
  return set;
}

/**
 * Pick the legal move that best explains the observed change set.
 *
 * A move must touch at least two changed squares (a single changed square is
 * almost always occlusion noise or a nudged piece) and must not leave more
 * than two changed squares unexplained.
 */
export function inferMove(legalMoves, changed, { minScore = 1.2, minMargin = 0.55 } = {}) {
  const ranked = [];
  for (const m of legalMoves) {
    if (m.promotion && m.promotion !== 'q') continue;
    const touched = moveSquares(m);
    let hits = 0;
    for (const s of touched) if (changed.has(s)) hits++;
    let extras = 0;
    for (const s of changed) if (!touched.has(s)) extras++;

    const need = Math.min(2, touched.size);
    if (hits < need) continue;
    if (hits / touched.size < 0.6) continue;
    if (extras > 2) continue;
    ranked.push({ move: m, hits, extras, score: hits - 0.45 * extras });
  }
  ranked.sort((a, b) => b.score - a.score || a.extras - b.extras);

  const best = ranked[0] || null;
  const margin = best && ranked[1] ? best.score - ranked[1].score : Infinity;
  const ambiguous = !best || margin < minMargin;
  const accepted = !!best && !ambiguous && best.score >= minScore;
  return { move: accepted ? best.move : null, best, ranked, margin, ambiguous, accepted };
}

/**
 * Frame-to-frame change detector for a locked board.
 *
 * `push()` is called with the descriptor of every processed frame. It reports
 * a change set once the board has been still for two frames, which is when a
 * physical move has been completed.
 */
export class MoveReader {
  constructor() {
    this.reset();
  }

  reset() {
    this.base = null;   // descriptor of the last confirmed position
    this.prev = null;   // descriptor of the previous frame
    this.calm = 0;
    this.noise = 6;
    this.changed = new Set();
  }

  /** Accept the current descriptor as the new confirmed position. */
  commit(desc) {
    this.base = desc;
    this.prev = desc;
    this.calm = 0;
    this.changed = new Set();
  }

  push(desc) {
    if (!this.base) {
      this.base = this.prev = desc;
      return { changed: new Set(), settled: false, motion: 0, noise: this.noise };
    }

    const instant = squareDiff(desc, this.prev);
    const motion = median(instant);
    this.prev = desc;

    if (motion < this.noise * 1.8) this.calm++;
    else this.calm = 0;

    // Track the noise floor only while the board is still.
    if (motion < this.noise * 1.8) this.noise += (Math.max(2.5, motion) - this.noise) * 0.06;

    const threshold = Math.max(10, this.noise * 3.2);
    const vsBase = squareDiff(desc, this.base);
    const changed = new Set();
    for (let i = 0; i < 64; i++) if (vsBase[i] > threshold) changed.add(i);
    this.changed = changed;

    // fire exactly once per settling, not on every calm frame after it
    const settled = this.calm === 2 && changed.size > 0;
    return { changed, settled, motion, noise: this.noise, threshold };
  }
}
