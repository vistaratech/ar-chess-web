/*
 * engine-node.mjs — engine checks that run without a browser.
 *
 *   node tests/engine-node.mjs
 *
 * Two things are tested:
 *
 *   1. The move generator is correct. Perft counts are compared against the
 *      published reference values for the start position, Kiwipete and the
 *      standard positions 3–6. A generator that is merely "usually right"
 *      would still pass a tactical test now and then, so this is the part that
 *      keeps the engine honest.
 *
 *   2. The search behaves like a chess player. It must find mate in one, take a
 *      hanging queen, reach a useful depth quickly, and answer for both sides.
 *
 * No framework: the file exits non-zero if any check fails, so it can be wired
 * into CI with a one-line command.
 */

import { Chess } from '../vendor/chess.js';
import { perft, loadFen, computeHash, hashLo, hashHi, turn, makeMove, generate, isLegal, moveBuf, ply, inCheck } from '../js/engine-board.js';
import { analyze } from '../js/engine.js';

let passed = 0;
let failed = 0;
const failures = [];

function check(name, good, detail = '') {
  if (good) {
    passed++;
    console.log(`  ok    ${name}${detail ? ` (${detail})` : ''}`);
  } else {
    failed++;
    failures.push(name);
    console.log(`  FAIL  ${name}${detail ? ` (${detail})` : ''}`);
  }
}

/* ------------------------------------------------------------------ */
/* 1. perft                                                            */
/* ------------------------------------------------------------------ */

const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
const KIWIPETE = 'r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1';
const POS3 = '8/2p5/3p4/KP5r/1R3p1k/8/4P1P1/8 w - - 0 1';
const POS4 = 'r3k2r/Pppp1ppp/1b3nbN/nP6/BBP1P3/q4N2/Pp1P2PP/R2Q1RK1 w kq - 0 1';
const POS5 = 'rnbq1k1r/pp1Pbppp/2p5/8/2B5/8/PPP1NnPP/RNBQK2R w KQ - 1 8';
const POS6 = 'r4rk1/1pp1qppp/p1np1n2/2b1p1B1/2B1P1b1/P1NP1N2/1PP1QPPP/R4RK1 w - - 0 10';

const PERFT = [
  ['start', START, [20, 400, 8902, 197281, 4865609]],
  ['kiwipete', KIWIPETE, [48, 2039, 97862]],
  ['position 3', POS3, [14, 191, 2812, 43238]],
  ['position 4', POS4, [6, 264, 9467]],
  ['position 5', POS5, [44, 1486, 62379]],
  ['position 6', POS6, [46, 2079, 89890]],
];

console.log('\nperft');
for (const [name, fen, counts] of PERFT) {
  for (let depth = 1; depth <= counts.length; depth++) {
    const t = performance.now();
    const got = perft(fen, depth);
    const ms = performance.now() - t;
    check(`${name} depth ${depth}`, got === counts[depth - 1],
      `${got}${got === counts[depth - 1] ? '' : ` != ${counts[depth - 1]}`}, ${ms.toFixed(0)}ms`);
  }
}

/* Hash and legality after every make/unmake in a random game. This catches an
 * incremental update that drifts from the board even when perft still passes
 * (perft unmakes everything before it reads the board). */
{
  loadFen(START);
  let seed = 1;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  let plies = 0;
  let mismatches = 0;
  for (let step = 0; step < 300; step++) {
    const n = generate(turn, false, moveBuf, ply * 256);
    const legal = [];
    for (let i = 0; i < n; i++) {
      const m = moveBuf[ply * 256 + i];
      if (isLegal(m, turn)) legal.push(m);
    }
    if (!legal.length) break;
    makeMove(legal[Math.floor(rnd() * legal.length)]);
    plies++;
    const lo = hashLo, hi = hashHi;
    computeHash();
    if (lo !== hashLo || hi !== hashHi || inCheck(turn ^ 1)) mismatches++;
  }
  check('hash and legality over a random game', mismatches === 0, `${plies} plies`);
}

/* ------------------------------------------------------------------ */
/* 2. tactics                                                          */
/* ------------------------------------------------------------------ */

console.log('\ntactics');
const TACTICS = [
  {
    name: 'mate in 1',
    fen: '6k1/5ppp/8/8/8/8/5PPP/4R1K1 w - - 0 1',
    ms: 700,
    want: 'Re8#',
    mate: true,
  },
  {
    name: 'back rank mate',
    fen: '6k1/5ppp/8/8/8/8/5PPP/R5K1 w - - 0 1',
    ms: 700,
    want: 'Ra8#',
    mate: true,
  },
  {
    name: 'take the hanging queen',
    fen: 'rnb1kbnr/ppp2ppp/8/3q4/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 1',
    ms: 1500,
    want: 'exd5',
    minScore: 500,
  },
  {
    name: 'start position',
    fen: START,
    ms: 1200,
    minDepth: 6,
    color: 'w',
  },
  {
    name: 'black to move',
    fen: 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1',
    ms: 1200,
    minDepth: 6,
    color: 'b',
  },
];

for (const t of TACTICS) {
  const t0 = performance.now();
  const r = analyze(t.fen, { ms: t.ms });
  const ms = performance.now() - t0;
  if (!r) {
    check(t.name, false, 'no move returned');
    continue;
  }

  const game = new Chess(t.fen);
  const move = game.moves({ verbose: true }).find((m) =>
    m.from === r.from && m.to === r.to && (m.promotion || null) === (r.promotion || null));
  const legal = !!move;
  const detail = `${r.san} d${r.depth} ${r.nodes} nodes ${ms.toFixed(0)}ms`;

  check(`${t.name}: legal move`, legal, r.san);
  check(`${t.name}: agrees with chess.js`, r.agreed, r.san);
  if (t.want) check(`${t.name}: plays ${t.want}`, r.san === t.want, r.san);
  if (t.mate) check(`${t.name}: reports mate`, r.score > 90000, String(r.score));
  if (t.minScore) check(`${t.name}: winning score`, r.score >= t.minScore, String(r.score));
  if (t.minDepth) check(`${t.name}: reaches depth ${t.minDepth}`, r.depth >= t.minDepth, `d${r.depth}`);
  if (t.color) check(`${t.name}: moves for ${t.color}`, !!move && move.color === t.color, detail);
}

/* A quiet middlegame position: any legal move is fine, but it must be one, and
 * the search must not need more than its budget. */
{
  const fen = 'r1bqk2r/pppp1ppp/2n2n2/2b1p3/2B1P3/2N2N2/PPPP1PPP/R1BQK2R w KQkq - 0 6';
  const t0 = performance.now();
  const r = analyze(fen, { ms: 1500 });
  const ms = performance.now() - t0;
  check('middlegame returns a move', !!r && !!r.from, r ? r.san : 'none');
  check('middlegame stays inside the budget', ms < 4000, `${ms.toFixed(0)}ms`);
}

/* ------------------------------------------------------------------ */

console.log('');
if (failed) {
  console.log(`engine-node: ${passed} passed, ${failed} FAILED`);
  for (const f of failures) console.log(`  - ${f}`);
  process.exitCode = 1;
} else {
  console.log(`engine-node: all ${passed} checks passed`);
}
