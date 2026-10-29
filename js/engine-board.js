/*
 * engine-board.js — the position and move generator for the engine.
 *
 * A 0x88 board: 128 cells, `(sq & 0x88) === 0` means on the board, files and
 * ranks are packed into one index, and sliding moves are a loop in one
 * direction. Pieces are `(colour << 3) | type`, so White is 1..6 and Black is
 * 9..14. Moves are packed into 32-bit integers (from, to, promotion, flags,
 * captured type) because a search makes and unmakes millions of them and an
 * object per move would spend the whole budget in the collector.
 *
 * The rest of the engine (engine-eval.js, engine-search.js) reads the live
 * bindings exported here. Only this module mutates them, always through
 * loadFen/makeMove/unmakeMove, so the incremental Zobrist hash and the king
 * squares cannot drift out of step with the board.
 */

export const WHITE = 0, BLACK = 1;
export const PAWN = 1, KNIGHT = 2, BISHOP = 3, ROOK = 4, QUEEN = 5, KING = 6;

export const MATE = 100000;
export const INF = 1000000;
export const MAX_PLY = 96;
export const MAX_MOVES = 256;

export const F_EP = 1, F_CASTLE = 2, F_DOUBLE = 4, F_NULL = 8;

export const board = new Int8Array(128);
export const kingSq = new Int32Array(2);
/** Piece counts, indexed `colour * 8 + type`. */
export const counts = new Int32Array(16);

export let turn = WHITE;
export let castling = 0;       // 1 WK, 2 WQ, 4 BK, 8 BQ
export let epSquare = -1;
export let halfmove = 0;
export let fullmove = 1;
export let hashLo = 0;
export let hashHi = 0;
export let ply = 0;

const KNIGHT_DIRS = [-33, -31, -18, -14, 14, 18, 31, 33];
const KING_DIRS = [-17, -16, -15, -1, 1, 15, 16, 17];
const BISHOP_DIRS = [-17, -15, 15, 17];
const ROOK_DIRS = [-16, -1, 1, 16];

/** Moves for every ply, so recursion never allocates. */
export const moveBuf = new Int32Array((MAX_PLY + 8) * MAX_MOVES);

export const pack = (from, to, promo = 0, flags = 0, cap = 0) =>
  from | (to << 8) | (promo << 16) | (flags << 19) | (cap << 23);
export const mFrom = (m) => m & 127;
export const mTo = (m) => (m >>> 8) & 127;
export const mPromo = (m) => (m >>> 16) & 7;
export const mFlags = (m) => (m >>> 19) & 7;
export const mCap = (m) => (m >>> 23) & 15;

export const typeOf = (p) => p & 7;
export const colorOf = (p) => p >> 3;
export const pieceOf = (color, type) => (color << 3) | type;
export const onBoard = (sq) => (sq & 0x88) === 0;

/* ------------------------------------------------------------------ */
/* Zobrist                                                             */
/* ------------------------------------------------------------------ */

/* xorshift32, seeded so a run is reproducible. */
function makeRng(seed) {
  let x = seed >>> 0;
  return () => {
    x ^= x << 13; x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5; x >>>= 0;
    return x | 0;
  };
}

const zPieceLo = new Int32Array(16 * 128);
const zPieceHi = new Int32Array(16 * 128);
const zCastleLo = new Int32Array(16);
const zCastleHi = new Int32Array(16);
const zEpLo = new Int32Array(8);
const zEpHi = new Int32Array(8);
const zSideLo = 0x3c6ef372;
const zSideHi = 0x5a17b1c3;

{
  const rnd = makeRng(0x1badb002);
  for (let i = 0; i < zPieceLo.length; i++) { zPieceLo[i] = rnd(); zPieceHi[i] = rnd(); }
  for (let i = 0; i < 16; i++) { zCastleLo[i] = rnd(); zCastleHi[i] = rnd(); }
  for (let i = 0; i < 8; i++) { zEpLo[i] = rnd(); zEpHi[i] = rnd(); }
}

/** Recompute the hash from the board; makeMove updates it incrementally. */
export function computeHash() {
  let lo = 0, hi = 0;
  for (let r = 0; r < 8; r++) {
    for (let f = 0; f < 8; f++) {
      const sq = r * 16 + f;
      const p = board[sq];
      if (!p) continue;
      lo ^= zPieceLo[p * 128 + sq];
      hi ^= zPieceHi[p * 128 + sq];
    }
  }
  lo ^= zCastleLo[castling];
  hi ^= zCastleHi[castling];
  if (epSquare >= 0) {
    lo ^= zEpLo[epSquare & 7];
    hi ^= zEpHi[epSquare & 7];
  }
  if (turn === BLACK) {
    lo ^= zSideLo;
    hi ^= zSideHi;
  }
  hashLo = lo;
  hashHi = hi;
  return lo;
}

function pieceFromChar(ch) {
  const white = 'PNBRQK'.indexOf(ch);
  if (white >= 0) return white + 1;
  const black = 'pnbrqk'.indexOf(ch);
  if (black >= 0) return 8 + black + 1;
  return 0;
}

/** Reset every piece, right and clock from a FEN. Throws on malformed input. */
export function loadFen(fen) {
  loadFenInner(fen);
  return true;
}

function loadFenInner(fen) {
  const parts = String(fen).trim().split(/\s+/);
  if (parts.length < 4) throw new Error('bad fen');
  const rows = parts[0].split('/');
  if (rows.length !== 8) throw new Error('bad fen');

  board.fill(0);
  counts.fill(0);
  kingSq[0] = kingSq[1] = -1;

  for (let r = 0; r < 8; r++) {
    let file = 0;
    const row = rows[r];
    for (let i = 0; i < row.length; i++) {
      const ch = row[i];
      if (ch >= '1' && ch <= '8') {
        file += ch.charCodeAt(0) - 48;
      } else {
        const p = pieceFromChar(ch);
        if (!p || file > 7) throw new Error('bad fen');
        const sq = (7 - r) * 16 + file;
        board[sq] = p;
        const type = p & 7;
        if (type === KING) kingSq[p >> 3] = sq;
        counts[p]++;
        file++;
      }
    }
    if (file !== 8) throw new Error('bad fen');
  }
  if (kingSq[WHITE] < 0 || kingSq[BLACK] < 0) throw new Error('bad fen');

  turn = parts[1] === 'b' ? BLACK : WHITE;
  if (parts[1] !== 'w' && parts[1] !== 'b') throw new Error('bad fen');

  castling = 0;
  const rights = parts[2];
  if (rights.includes('K')) castling |= 1;
  if (rights.includes('Q')) castling |= 2;
  if (rights.includes('k')) castling |= 4;
  if (rights.includes('q')) castling |= 8;

  epSquare = -1;
  if (parts[3] !== '-') {
    const sq = squareFromName(parts[3]);
    if (sq >= 0) epSquare = sq;
  }

  halfmove = Number(parts[4]) || 0;
  fullmove = Number(parts[5]) || 1;
  ply = 0;
  computeHash();
}

export function squareFromName(name) {
  if (!name || name.length < 2) return -1;
  const file = 'abcdefgh'.indexOf(name[0]);
  const rank = name.charCodeAt(1) - 49;
  if (file < 0 || rank < 0 || rank > 7) return -1;
  return rank * 16 + file;
}

export function moveToUci(m) {
  const from = mFrom(m), to = mTo(m), promo = mPromo(m);
  const a = 'abcdefgh'[from & 7] + ((from >> 4) + 1);
  const b = 'abcdefgh'[to & 7] + ((to >> 4) + 1);
  return a + b + (promo ? 'nbrq'[promo - 2] : '');
}

/* ------------------------------------------------------------------ */
/* attacks                                                             */
/* ------------------------------------------------------------------ */

/** Is `sq` attacked by a piece of colour `by`? */
export function isSquareAttacked(sq, by) {
  // pawns: a white pawn attacks upward, so it sits one rank below the target
  if (by === WHITE) {
    let s = sq - 15;
    if (onBoard(s) && board[s] === pieceOf(WHITE, PAWN)) return true;
    s = sq - 17;
    if (onBoard(s) && board[s] === pieceOf(WHITE, PAWN)) return true;
  } else {
    let s = sq + 15;
    if (onBoard(s) && board[s] === pieceOf(BLACK, PAWN)) return true;
    s = sq + 17;
    if (onBoard(s) && board[s] === pieceOf(BLACK, PAWN)) return true;
  }

  const knight = pieceOf(by, KNIGHT);
  for (let i = 0; i < 8; i++) {
    const s = sq + KNIGHT_DIRS[i];
    if (onBoard(s) && board[s] === knight) return true;
  }

  const king = pieceOf(by, KING);
  for (let i = 0; i < 8; i++) {
    const s = sq + KING_DIRS[i];
    if (onBoard(s) && board[s] === king) return true;
  }

  const bishop = pieceOf(by, BISHOP);
  const queen = pieceOf(by, QUEEN);
  const rook = pieceOf(by, ROOK);

  for (let i = 0; i < 4; i++) {
    let s = sq + BISHOP_DIRS[i];
    while (onBoard(s)) {
      const p = board[s];
      if (p) {
        if (p === bishop || p === queen) return true;
        break;
      }
      s += BISHOP_DIRS[i];
    }
  }
  for (let i = 0; i < 4; i++) {
    let s = sq + ROOK_DIRS[i];
    while (onBoard(s)) {
      const p = board[s];
      if (p) {
        if (p === rook || p === queen) return true;
        break;
      }
      s += ROOK_DIRS[i];
    }
  }
  return false;
}

export function inCheck(us) {
  return isSquareAttacked(kingSq[us], us ^ 1);
}

/* ------------------------------------------------------------------ */
/* move generation                                                     */
/* ------------------------------------------------------------------ */

const PROMOS = [QUEEN, ROOK, BISHOP, KNIGHT];

/**
 * Fill `buf[offset..]` with pseudo-legal moves for `us`. `capturesOnly` is for
 * quiescence: quiet pawn pushes are skipped except promotions, and quiet
 * piece moves are not generated at all.
 */
export function generate(us, capturesOnly, buf, offset) {
  let n = 0;
  const them = us ^ 1;

  for (let r = 0; r < 8; r++) {
    for (let f = 0; f < 8; f++) {
      const sq = r * 16 + f;
      const p = board[sq];
      if (!p || (p >> 3) !== us) continue;
      const type = p & 7;

      if (type === PAWN) {
        const dir = us === WHITE ? 16 : -16;
        const startRank = us === WHITE ? 1 : 6;
        const promoRank = us === WHITE ? 6 : 1;
        const one = sq + dir;

        if (onBoard(one) && board[one] === 0) {
          if (r === promoRank) {
            for (let i = 0; i < 4; i++) buf[offset + n++] = pack(sq, one, PROMOS[i], 0, 0);
          } else if (!capturesOnly) {
            buf[offset + n++] = pack(sq, one, 0, 0, 0);
            if (r === startRank) {
              const two = sq + dir * 2;
              if (board[two] === 0) buf[offset + n++] = pack(sq, two, 0, F_DOUBLE, 0);
            }
          }
        }

        for (let d = -1; d <= 1; d += 2) {
          const to = sq + dir + d;
          if (!onBoard(to)) continue;
          const q = board[to];
          if (q && (q >> 3) === them) {
            const cap = q & 7;
            if (r === promoRank) {
              for (let i = 0; i < 4; i++) buf[offset + n++] = pack(sq, to, PROMOS[i], 0, cap);
            } else {
              buf[offset + n++] = pack(sq, to, 0, 0, cap);
            }
          } else if (!q && to === epSquare) {
            buf[offset + n++] = pack(sq, to, 0, F_EP, PAWN);
          }
        }
        continue;
      }

      if (type === KNIGHT || type === KING) {
        const dirs = type === KNIGHT ? KNIGHT_DIRS : KING_DIRS;
        for (let i = 0; i < 8; i++) {
          const to = sq + dirs[i];
          if (!onBoard(to)) continue;
          const q = board[to];
          if (q) {
            if ((q >> 3) === them) buf[offset + n++] = pack(sq, to, 0, 0, q & 7);
          } else if (!capturesOnly) {
            buf[offset + n++] = pack(sq, to, 0, 0, 0);
          }
        }
        if (type === KING && !capturesOnly) {
          if (us === WHITE) {
            if ((castling & 1) && board[4] === pieceOf(WHITE, KING) && board[5] === 0 && board[6] === 0 &&
                board[7] === pieceOf(WHITE, ROOK) &&
                !isSquareAttacked(4, BLACK) && !isSquareAttacked(5, BLACK) && !isSquareAttacked(6, BLACK)) {
              buf[offset + n++] = pack(4, 6, 0, F_CASTLE, 0);
            }
            if ((castling & 2) && board[4] === pieceOf(WHITE, KING) && board[3] === 0 && board[2] === 0 && board[1] === 0 &&
                board[0] === pieceOf(WHITE, ROOK) &&
                !isSquareAttacked(4, BLACK) && !isSquareAttacked(3, BLACK) && !isSquareAttacked(2, BLACK)) {
              buf[offset + n++] = pack(4, 2, 0, F_CASTLE, 0);
            }
          } else {
            if ((castling & 4) && board[116] === pieceOf(BLACK, KING) && board[117] === 0 && board[118] === 0 &&
                board[119] === pieceOf(BLACK, ROOK) &&
                !isSquareAttacked(116, WHITE) && !isSquareAttacked(117, WHITE) && !isSquareAttacked(118, WHITE)) {
              buf[offset + n++] = pack(116, 118, 0, F_CASTLE, 0);
            }
            if ((castling & 8) && board[116] === pieceOf(BLACK, KING) && board[115] === 0 && board[114] === 0 && board[113] === 0 &&
                board[112] === pieceOf(BLACK, ROOK) &&
                !isSquareAttacked(116, WHITE) && !isSquareAttacked(115, WHITE) && !isSquareAttacked(114, WHITE)) {
              buf[offset + n++] = pack(116, 114, 0, F_CASTLE, 0);
            }
          }
        }
        continue;
      }

      const dirs = type === BISHOP ? BISHOP_DIRS : type === ROOK ? ROOK_DIRS : BISHOP_DIRS;
      const second = type === QUEEN ? ROOK_DIRS : null;
      for (let pass = 0; pass < (second ? 2 : 1); pass++) {
        const list = pass === 0 ? dirs : second;
        for (let i = 0; i < 4; i++) {
          const d = list[i];
          let to = sq + d;
          while (onBoard(to)) {
            const q = board[to];
            if (q) {
              if ((q >> 3) === them) buf[offset + n++] = pack(sq, to, 0, 0, q & 7);
              break;
            }
            if (!capturesOnly) buf[offset + n++] = pack(sq, to, 0, 0, 0);
            to += d;
          }
        }
      }
    }
  }
  return n;
}

/**
 * Would `m` leave our king attacked? Castling is checked during generation
 * (start, transit and destination squares), so it is legal by construction.
 */
export function isLegal(m, us) {
  const flags = mFlags(m);
  if (flags & F_CASTLE) {
    // A castle is legal by construction in generate(); validate the shape too
    // so a stale transposition-table move can never be applied blindly.
    const from = mFrom(m), to = mTo(m);
    if (from !== (us === WHITE ? 4 : 116)) return false;
    if (us === WHITE) {
      if (to === 6) return (castling & 1) !== 0 && board[5] === 0 && board[6] === 0 && board[7] === pieceOf(WHITE, ROOK);
      if (to === 2) return (castling & 2) !== 0 && board[3] === 0 && board[2] === 0 && board[1] === 0 && board[0] === pieceOf(WHITE, ROOK);
    } else {
      if (to === 118) return (castling & 4) !== 0 && board[117] === 0 && board[118] === 0 && board[119] === pieceOf(BLACK, ROOK);
      if (to === 114) return (castling & 8) !== 0 && board[115] === 0 && board[114] === 0 && board[113] === 0 && board[112] === pieceOf(BLACK, ROOK);
    }
    return false;
  }

  const from = mFrom(m), to = mTo(m);
  const piece = board[from];
  if (!piece) return false;
  const capSq = (flags & F_EP) ? (us === WHITE ? to - 16 : to + 16) : to;
  const captured = board[capSq];

  board[from] = 0;
  board[to] = piece;
  if (flags & F_EP) board[capSq] = 0;

  const oldKing = kingSq[us];
  if ((piece & 7) === KING) kingSq[us] = to;
  const ok = !isSquareAttacked(kingSq[us], us ^ 1);

  board[from] = piece;
  board[to] = captured && capSq === to ? captured : 0;
  if (flags & F_EP) board[capSq] = captured;
  kingSq[us] = oldKing;
  return ok;
}

/* ------------------------------------------------------------------ */
/* make / unmake                                                       */
/* ------------------------------------------------------------------ */

const H = MAX_PLY + 8;
const hFrom = new Int32Array(H);
const hTo = new Int32Array(H);
const hFlags = new Int32Array(H);
const hPromo = new Int32Array(H);
const hCapSq = new Int32Array(H);
const hCapPiece = new Int32Array(H);
const hPiece = new Int32Array(H);
const hCastling = new Int32Array(H);
const hEp = new Int32Array(H);
const hHalf = new Int32Array(H);
const hFull = new Int32Array(H);
const hHashLo = new Int32Array(H);
const hHashHi = new Int32Array(H);
const hKingW = new Int32Array(H);
const hKingB = new Int32Array(H);
const hTurn = new Int32Array(H);

function xorPiece(p, sq) {
  hashLo ^= zPieceLo[p * 128 + sq];
  hashHi ^= zPieceHi[p * 128 + sq];
}

export function makeMove(m) {
  const from = mFrom(m), to = mTo(m);
  const flags = mFlags(m), promo = mPromo(m);
  const piece = board[from];
  const us = piece >> 3, them = us ^ 1;
  const type = piece & 7;
  const capSq = (flags & F_EP) ? (us === WHITE ? to - 16 : to + 16) : to;
  const capPiece = board[capSq];
  const h = ply;

  hFrom[h] = from; hTo[h] = to; hFlags[h] = flags; hPromo[h] = promo;
  hCapSq[h] = capSq; hCapPiece[h] = capPiece; hPiece[h] = piece;
  hCastling[h] = castling; hEp[h] = epSquare; hHalf[h] = halfmove;
  hFull[h] = fullmove; hHashLo[h] = hashLo; hHashHi[h] = hashHi;
  hKingW[h] = kingSq[WHITE]; hKingB[h] = kingSq[BLACK]; hTurn[h] = turn;

  // remove the old rights / ep from the hash
  hashLo ^= zCastleLo[castling];
  hashHi ^= zCastleHi[castling];
  if (epSquare >= 0) {
    hashLo ^= zEpLo[epSquare & 7];
    hashHi ^= zEpHi[epSquare & 7];
  }

  board[from] = 0;
  const placed = promo ? pieceOf(us, promo) : piece;
  board[to] = placed;

  if (capPiece) {
    if (capSq !== to) board[capSq] = 0;
    xorPiece(capPiece, capSq);
    counts[them * 8 + (capPiece & 7)]--;
  }

  xorPiece(piece, from);
  xorPiece(placed, to);

  counts[us * 8 + type]--;
  if (promo) counts[us * 8 + promo]++;

  if (type === KING) {
    kingSq[us] = to;
    if (flags & F_CASTLE) {
      let rf, rt;
      if (to === 6) { rf = 7; rt = 5; }
      else if (to === 2) { rf = 0; rt = 3; }
      else if (to === 118) { rf = 119; rt = 117; }
      else { rf = 112; rt = 115; }
      const rook = board[rf];
      board[rf] = 0;
      board[rt] = rook;
      xorPiece(rook, rf);
      xorPiece(rook, rt);
    }
  }

  let rights = castling;
  if (type === KING) {
    rights &= us === WHITE ? ~3 : ~12;
  } else if (type === ROOK) {
    if (from === 0) rights &= ~2;
    else if (from === 7) rights &= ~1;
    else if (from === 112) rights &= ~8;
    else if (from === 119) rights &= ~4;
  }
  if (capPiece && (capPiece & 7) === ROOK) {
    if (capSq === 0) rights &= ~2;
    else if (capSq === 7) rights &= ~1;
    else if (capSq === 112) rights &= ~8;
    else if (capSq === 119) rights &= ~4;
  }
  castling = rights;
  hashLo ^= zCastleLo[castling];
  hashHi ^= zCastleHi[castling];

  epSquare = -1;
  if (flags & F_DOUBLE) {
    // The ep *target* is one square behind the pawn's landing square. Only
    // record it when an enemy pawn is actually beside the pawn now, so the
    // Zobrist key does not distinguish positions that are identical in play.
    const ep = us === WHITE ? from + 16 : from - 16;
    const landing = ep + (us === WHITE ? 16 : -16);
    const enemy = pieceOf(them, PAWN);
    if ((onBoard(landing - 1) && board[landing - 1] === enemy) ||
        (onBoard(landing + 1) && board[landing + 1] === enemy)) {
      epSquare = ep;
    }
  }
  if (epSquare >= 0) {
    hashLo ^= zEpLo[epSquare & 7];
    hashHi ^= zEpHi[epSquare & 7];
  }

  if (type === PAWN || capPiece) halfmove = 0; else halfmove++;
  if (us === BLACK) fullmove++;

  turn = them;
  hashLo ^= zSideLo;
  hashHi ^= zSideHi;
  ply++;
}

export function unmakeMove() {
  ply--;
  const h = ply;
  const from = hFrom[h], to = hTo[h], flags = hFlags[h], promo = hPromo[h];
  const piece = hPiece[h];
  const capSq = hCapSq[h], capPiece = hCapPiece[h];
  const us = piece >> 3;

  if (flags & F_CASTLE) {
    let rf, rt;
    if (to === 6) { rf = 7; rt = 5; }
    else if (to === 2) { rf = 0; rt = 3; }
    else if (to === 118) { rf = 119; rt = 117; }
    else { rf = 112; rt = 115; }
    const rook = board[rt];
    board[rt] = 0;
    board[rf] = rook;
  }

  board[to] = capPiece && capSq === to ? capPiece : 0;
  board[from] = piece;
  if (flags & F_EP) board[capSq] = capPiece;

  if (capPiece) counts[(us ^ 1) * 8 + (capPiece & 7)]++;
  const type = piece & 7;
  counts[us * 8 + type]++;
  if (promo) counts[us * 8 + promo]--;

  turn = hTurn[h];
  castling = hCastling[h];
  epSquare = hEp[h];
  halfmove = hHalf[h];
  fullmove = hFull[h];
  hashLo = hHashLo[h];
  hashHi = hHashHi[h];
  kingSq[WHITE] = hKingW[h];
  kingSq[BLACK] = hKingB[h];
}

export function makeNull() {
  const h = ply;
  hFlags[h] = F_NULL; hPiece[h] = 0; hFrom[h] = 0; hTo[h] = 0; hPromo[h] = 0;
  hCapSq[h] = 0; hCapPiece[h] = 0;
  hCastling[h] = castling; hEp[h] = epSquare; hHalf[h] = halfmove;
  hFull[h] = fullmove; hHashLo[h] = hashLo; hHashHi[h] = hashHi;
  hKingW[h] = kingSq[WHITE]; hKingB[h] = kingSq[BLACK]; hTurn[h] = turn;

  if (epSquare >= 0) {
    hashLo ^= zEpLo[epSquare & 7];
    hashHi ^= zEpHi[epSquare & 7];
    epSquare = -1;
  }
  halfmove++;
  turn ^= 1;
  hashLo ^= zSideLo;
  hashHi ^= zSideHi;
  ply++;
}

export function unmakeNull() {
  ply--;
  const h = ply;
  turn = hTurn[h];
  castling = hCastling[h];
  epSquare = hEp[h];
  halfmove = hHalf[h];
  fullmove = hFull[h];
  hashLo = hHashLo[h];
  hashHi = hHashHi[h];
  kingSq[WHITE] = hKingW[h];
  kingSq[BLACK] = hKingB[h];
}

export function hasNonPawn(us) {
  const b = us * 8;
  return counts[b + KNIGHT] + counts[b + BISHOP] + counts[b + ROOK] + counts[b + QUEEN] > 0;
}

/* ------------------------------------------------------------------ */
/* perft                                                               */
/* ------------------------------------------------------------------ */

function perftInner(depth) {
  if (depth === 0) return 1;
  const base = ply * MAX_MOVES;
  const n = generate(turn, false, moveBuf, base);
  let total = 0;
  for (let i = 0; i < n; i++) {
    const m = moveBuf[base + i];
    if (!isLegal(m, turn)) continue;
    makeMove(m);
    total += perftInner(depth - 1);
    unmakeMove();
  }
  return total;
}

/** Exact legal-move count; the correctness test for the generator. */
export function perft(fen, depth) {
  loadFen(fen);
  ply = 0;
  return perftInner(depth);
}
