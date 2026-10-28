/*
 * coach.js — the read → recommend → verify loop, with no DOM in it.
 *
 * The camera loop hands the coach the set of board squares whose appearance
 * changed. The coach decides what that means for the game, keeps at most one
 * recommendation alive, and drops it the moment the position moves on. Keeping
 * this out of app.js is what makes the whole loop testable against the
 * synthetic board in tests/harness.html.
 *
 * The rule that matters for the overlay: a recommendation is valid only while
 * it belongs to the *current* position. Once the board changes — whether the
 * change is understood or not — the arrow must go. An arrow left on screen for
 * a move that has already been played (or for a position that no longer
 * exists) is worse than no arrow at all.
 */

import { inferMove } from './track.js';

const SIDE_NAME = { w: 'White', b: 'Black' };

/** Are these the same move, regardless of annotations? */
export function sameMove(a, b) {
  return !!a && !!b && a.from === b.from && a.to === b.to;
}

export class Coach {
  /**
   * @param {import('../vendor/chess.js').Chess} game  position read so far
   * @param {{side?: 'w'|'b'}} opts  the side the player is playing
   */
  constructor(game, { side = 'b' } = {}) {
    this.game = game;
    this.side = side;
    this.suggestion = null;   // { from, to, san, score, depth, fen }
    this.thinking = false;
    this.req = 0;             // id of the newest engine request
  }

  /** Is it the player's turn (and the game still running)? */
  get myTurn() {
    return !this.game.game_over() && this.game.turn() === this.side;
  }

  get opponent() {
    return this.side === 'w' ? 'b' : 'w';
  }

  get opponentName() {
    return SIDE_NAME[this.opponent];
  }

  get sideName() {
    return SIDE_NAME[this.side];
  }

  /**
   * The move the overlay may draw, or null.
   *
   * Three independent guards, so a stale arrow cannot be drawn even if one of
   * them is forgotten elsewhere: there is a recommendation, it was computed for
   * exactly the position on the board now, and it is our move.
   */
  get guidance() {
    const s = this.suggestion;
    return s && s.fen === this.game.fen() && this.myTurn ? s : null;
  }

  /** Forget the recommendation and invalidate any engine answer in flight. */
  drop() {
    this.suggestion = null;
    this.thinking = false;
    this.req++;
  }

  setSide(side) {
    this.side = side;
    this.drop();
  }

  reset() {
    this.game.reset();
    this.drop();
  }

  undo() {
    const ok = this.game.undo();
    this.drop();
    return ok;
  }

  /**
   * Ask for a move for our side.
   *
   * Returns `{id, fen}` when the caller should send a think request, or null
   * when it is the opponent's turn or the game is over. Any previous
   * recommendation is dropped first: it belongs to a position that just
   * changed.
   */
  request() {
    this.drop();
    if (this.game.game_over() || !this.myTurn) return null;
    this.thinking = true;
    return { id: this.req, fen: this.game.fen() };
  }

  /** Accept an engine answer. Stale or off-turn answers are ignored. */
  best(id, msg) {
    if (id !== this.req) return false;
    this.thinking = false;
    if (!msg || !msg.from || msg.fen !== this.game.fen() || !this.myTurn) return false;
    this.suggestion = {
      from: msg.from,
      to: msg.to,
      san: msg.san,
      score: msg.score || 0,
      depth: msg.depth || 0,
      fen: msg.fen,
    };
    return true;
  }

  /**
   * Interpret a settled change set from the physical board.
   *
   * - `accepted: false` — the squares do not add up to a legal move. Any
   *   recommendation is dropped (the position it was made for is gone); the
   *   caller should ask for a resync rather than leave the arrow up.
   * - `accepted: true, played: true` — the move that was recommended has been
   *   played and verified against the board. This is the signal the overlay
   *   disappears on.
   * - `accepted: true, played: false` — some other legal move was played.
   *
   * The game position is updated on an accepted read and nothing else is; the
   * caller owns re-baselining its frame reference.
   */
  read(changed) {
    const fenBefore = this.game.fen();
    // Only a recommendation made for *this* position can be "the move played".
    const expected = this.suggestion && this.suggestion.fen === fenBefore
      ? this.suggestion : null;

    const inf = inferMove(this.game.moves({ verbose: true }), changed);
    let accepted = inf.accepted;
    let move = inf.move;
    let viaSuggestion = false;

    if (!accepted && expected) {
      // The recommended move is a legal move whose squares all changed, and it
      // explains the change set at least as well as anything else. The user was
      // told to play exactly this, so a single unrelated square also moving (a
      // nudge, a shadow) should not turn it into "could not read that move".
      const cand = inf.ranked.find((r) => sameMove(r.move, expected));
      if (cand && (!inf.best || cand.score >= inf.best.score)) {
        accepted = true;
        move = cand.move;
        viaSuggestion = true;
      }
    }

    if (!accepted) {
      const had = !!this.suggestion;
      this.drop();
      return { accepted: false, played: false, viaSuggestion: false, cleared: had, move: null, inf };
    }

    const played = sameMove(expected, move);
    this.game.move({ from: move.from, to: move.to, promotion: move.promotion || 'q' });
    this.drop();
    return { accepted: true, played, viaSuggestion, cleared: true, move, inf };
  }
}
