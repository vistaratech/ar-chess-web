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
 * A move must touch at least two changed squares, must have *all* of its own
 * squares changed (hits === touched.size), and must leave at most one changed
 * square unexplained: with a 2-square allowance several unrelated moves fit
 * the same three changed squares equally well, which is what made the reader
 * report "ambiguous" instead of the obvious move.
 */
export function inferMove(legalMoves, changed, { minScore = 1.6, minMargin = 0.5 } = {}) {
  const ranked = [];
  for (const m of legalMoves) {
    if (m.promotion && m.promotion !== 'q') continue;
    const touched = moveSquares(m);
    let hits = 0;
    for (const s of touched) if (changed.has(s)) hits++;
    let extras = 0;
    for (const s of changed) if (!touched.has(s)) extras++;

    if (hits < Math.min(2, touched.size)) continue;
    if (hits !== touched.size) continue;
    if (extras > 1) continue;
    ranked.push({ move: m, hits, extras, score: hits - 1.2 * extras });
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
    this.fired = false;
    this.noise = 3;
    this.changed = new Set();
  }

  /** Accept the current descriptor as the new confirmed position. */
  commit(desc) {
    this.base = desc;
    this.prev = desc;
    this.calm = 0;
    this.fired = false;
    this.changed = new Set();
  }

  push(desc, { gridMoved = false } = {}) {
    if (!this.base || gridMoved) {
      // A different sampling grid makes every square incomparable, so take the
      // frame as the new reference instead of reporting a board-wide change.
      this.base = this.prev = desc;
      this.calm = 0;
      this.fired = false;
      this.changed = new Set();
      return { changed: new Set(), settled: false, motion: 0, noise: this.noise, threshold: 0, rebased: true };
    }

    const instant = squareDiff(desc, this.prev);
    const motion = median(instant);
    this.prev = desc;

    if (motion < this.noise * 1.8) this.calm++;
    else { this.calm = 0; this.fired = false; }

    // Track the noise floor only while the board is still.
    if (motion < this.noise * 1.8) this.noise += (Math.max(2.5, motion) - this.noise) * 0.06;

    const threshold = Math.max(13, this.noise * 3);
    const vsBase = squareDiff(desc, this.base);
    const changed = new Set();
    for (let i = 0; i < 64; i++) if (vsBase[i] > threshold) changed.add(i);
    this.changed = changed;

    // fire once per settling: after two still frames with something changed
    const settled = this.calm >= 2 && changed.size > 0 && !this.fired;
    if (settled) this.fired = true;
    return { changed, settled, motion, noise: this.noise, threshold };
  }
}
