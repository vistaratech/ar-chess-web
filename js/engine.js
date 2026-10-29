/*
 * engine.js — the module worker the page talks to.
 *
 * The search itself lives in engine-search.js (with the board in
 * engine-board.js and the evaluation in engine-eval.js). This file is only the
 * boundary: it turns the chosen 0x88 move into SAN with chess.js, verifies that
 * chess.js agrees the move is legal, and posts the protocol messages.
 *
 * Using chess.js for the last step is deliberate. The fast generator has been
 * perft-checked, but a coach that draws an illegal arrow is worse than a slow
 * one, so the engine's answer is always cross-checked against a second, trusted
 * move generator. If they ever disagree the page gets a legal move instead.
 *
 * Protocol
 *   in : { type: 'think', id, fen, ms, maxDepth? }   ms = time budget
 *   out: { type: 'best', id, fen, from, to, promotion, san, score, depth, nodes, pv }
 *        { type: 'info', id, depth, score, nodes, pv }   after each depth
 *        { type: 'error', id, fen, error }
 *
 * `id` is echoed on every reply so the page can throw away an answer for a
 * position it has already left (the user moved while the engine was thinking).
 */

import { Chess } from '../vendor/chess.js';
import { searchPosition } from './engine-search.js';

const PROMO = ['', '', 'n', 'b', 'r', 'q'];

function nameOf(sq) {
  return 'abcdefgh'[sq & 7] + ((sq >> 4) + 1);
}

/**
 * Search a FEN and return the move in both 0x88 and SAN form.
 *
 * Exported so tests can drive the engine directly in Node or the browser
 * without going through the worker.
 */
export function analyze(fen, { ms = 1800, maxDepth = 64, onInfo = null } = {}) {
  const result = searchPosition(fen, { ms, maxDepth, onInfo });
  if (!result) return null;

  const game = new Chess();
  try {
    game.load(fen);
  } catch {
    return null;
  }

  const legal = game.moves({ verbose: true });
  if (!legal.length) return null;

  const from = nameOf(result.from);
  const to = nameOf(result.to);
  const promo = result.promotion ? PROMO[result.promotion] : null;
  let move = legal.find((m) =>
    m.from === from && m.to === to && (!promo || m.promotion === promo));

  // A second generator gets the last word. This branch should be unreachable;
  // it exists so a generator bug can never put an illegal arrow on the board.
  const agreed = !!move;
  if (!move) move = legal[0];

  return {
    from: move.from,
    to: move.to,
    promotion: move.promotion || null,
    san: move.san,
    score: result.score,
    depth: result.depth,
    nodes: result.nodes,
    pv: result.pv,
    agreed,
  };
}

/* The worker handler is installed only in a worker scope; importing this file
 * in Node for tests must not throw. */
if (typeof self !== 'undefined' && typeof self.postMessage === 'function') {
  self.onmessage = (e) => {
    const msg = e.data;
    if (!msg || msg.type !== 'think') return;

    try {
      const best = analyze(msg.fen, {
        ms: msg.ms || 1800,
        maxDepth: msg.maxDepth || 64,
        onInfo: (info) => self.postMessage({
          type: 'info',
          id: msg.id,
          depth: info.depth,
          score: info.score,
          nodes: info.nodes,
          pv: info.pv,
        }),
      });

      if (!best) {
        self.postMessage({
          type: 'best', id: msg.id, fen: msg.fen,
          from: null, to: null, promotion: null, san: '',
          score: 0, depth: 0, nodes: 0, pv: [],
        });
        return;
      }

      self.postMessage({
        type: 'best',
        id: msg.id,
        fen: msg.fen,
        from: best.from,
        to: best.to,
        promotion: best.promotion,
        san: best.san,
        score: best.score,
        depth: best.depth,
        nodes: best.nodes,
        pv: best.pv,
      });
    } catch (err) {
      self.postMessage({
        type: 'error',
        id: msg.id,
        fen: msg.fen,
        error: String((err && err.message) || err || 'engine error'),
      });
    }
  };
}
