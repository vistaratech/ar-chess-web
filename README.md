# AR Chess

Point a phone at a chessboard. The board is found and tracked automatically. You
can confirm a position square by square, analyze it, and save labeled square
images locally for future piece-recognition work.

Live: <https://ar-chess-web.vercel.app>

## What it does

- **Automatic board detection.** No calibration step. As soon as the camera opens
  the app looks for the board and outlines it.
- **Wherever the board is.** The search runs over the whole frame at three scales,
  so a board in a corner, half off to one side, small because the phone is across
  the table, or filling the picture are all the same case. Nothing about the last
  position biases the first search.
- **Continuous tracking.** The outline follows the board while the phone moves,
  rotates or changes angle. The local re-fit is predicted from the last few
  frames, so a pan does not lag a frame behind; a bigger change re-runs the full
  search.
- **Tolerates hands and arms on the board.** The board score is measured twice:
  strictly over all 64 cells, and again with the cells that fit neither square
  colour dropped. An arm lying across the board ruins the first and barely dents
  the second, so tracking stays glued while somebody moves pieces, and a move
  played *under* a resting hand is read as soon as the hand lifts.
- **Tracks moves after position confirmation.** Once the board position has been
  confirmed and synchronized, after the board has been still for two frames,
  the squares that changed appearance are matched against the legal moves of the
  current position, and the move is played in the app's own game state. The
  squares are sampled on a grid that is *kept* between frames and only moved when
  the board itself moves, so a sub-pixel re-fit cannot fake a change on a dozen
  squares. Whichever side moved is detected; no "it is my turn" button.
- **Recommends your reply.** Once it is your turn, a real search engine running in
  a Web Worker returns the best move: 0x88 board, iterative deepening,
  principal-variation search, transposition table, null-move and futility pruning,
  late-move reductions, and a quiescence search over captures and promotions. The
  move is drawn as an arrow with the piece's square and the destination both
  ringed, with the evaluation and depth in the HUD. In the ~2 s budget it reaches
  depth 9–11, so it finds mates and wins material rather than guessing. The arrow
  is yours only: while the opponent is to move there is no arrow, and the engine
  does not waste its budget on a move the opponent's reply would replace.
- **Verifies the move was actually played.** When the board changes, the read is
  compared with the recommendation. The arrow is dropped in the same frame the
  move is read — before the next frame is drawn — and the app then waits for the
  opponent's move. A change the app cannot read as a legal move also drops the
  arrow (and asks for a resync): guidance is never left pointing at a position
  that no longer exists. If a hand is over the board the arrow is held while the
  move is hidden, and cleared the moment the move underneath it is confirmed.
- **Your side.** White is the default, because the person holding the phone is
  usually the one moving up the board, and the choice is remembered across reloads.
  Select "I play Black" and the app expects the board to be seen from Black's side
  of the table and names the squares accordingly. A suggestion is always produced
  when it is the selected side's turn: if a worker ever fails or stalls, the app
  restarts it and asks again instead of leaving the line blank.
- **Confirm a current position.** On first use, after a missed move, or after
  **Resync**, choose **Set position**, mark every occupied
  square with its piece, and confirm the side to move, castling rights, and
  en-passant square. The app validates the resulting position before searching;
  it only recommends a move when the selected side is actually to move.
- **Build a local recognition dataset.** Confirming a position saves one rectified
  48×48 image and its piece label for each square in this browser's IndexedDB.
  Use **Export labeled data** to download the samples. Images are not uploaded.

Demo without a camera: **`?demo=1`** renders a synthetic board that plays both
sides. The opponent's replies are scripted; your side plays exactly the move the
arrow shows, so the whole read → recommend → verify → clear loop can be watched on
a desktop.

## Recognition status and limits

- **Automatic piece recognition is not implemented.** The camera finds the board
  and rectifies its squares, but it does not identify piece type or color. Use
  **Set position** to enter and verify all 64 squares. The labeled captures are a
  data-collection workflow, not a trained model; exported data must be used to
  train and validate one before hands-free position recognition is possible.
- A still board does not encode whose turn it is, castling rights, or an
  en-passant target. Confirm these in the position editor. The app will not search
  when it is not the selected player's turn.
- Detection is a classical computer-vision pipeline (Hough lines, pyramid,
  colour-parity scoring, ridge snapping), not a neural network. It is reliable for
  a visible board with reasonable contrast and light; it can fail on heavy clutter
  or extreme perspective (a strongly foreshortened far edge).
- **How small is too small?** What matters is the size of a *square* in the frame
  the app processes (the camera frame is scaled down to at most 720 px on the long
  edge). At 11 px per square and up — a board at ~25 % of the short side —
  detection is occasional (about 3 in 4 poses in the sweep below); at 16 px and up
  (~35 %) it is essentially certain, and at 22 px (~50 %) it never missed in the
  sweep. Below ~10 px per square the board's rim is softer than the squares inside
  it and the search stops finding it — at that size the pieces are a few pixels
  across and there is nothing left to read anyway.
- **A board cut by the edge of the frame is not supported.** The rim is what the
  detector locks onto, and a side that runs off the picture has no edge to find.
  A board cropped by 3 % is found about two times in three, one cropped by 20 %
  never is. Keep the whole board in view.
- **The first lock wants most of the board.** A hand or a forearm over a corner or
  an edge is fine (6/6 poses in the test suite), but if half the board is covered
  at the moment the camera opens the app keeps searching until it can see enough
  of it. Once locked, covering the board does not drop the lock.
- In move tracking, pieces are detected as *changed squares*, not identified. A move is only
  reported when the change set matches exactly one legal move well enough. A hand
  crossing the board is not treated as a move and does not throw away the
  reference either: the app shows "Hand over the board — waiting for a clear view"
  and reads the move underneath it when the board is clear. (If a large change
  stays put for a few seconds it is treated as an unreadable position and the app
  asks you to enter the current board.)
- **A move the app cannot read drops the arrow instead of keeping it.** If the
  board changes in a way no legal move explains — a piece knocked over, a move
  played out of turn, a mistake earlier in the game — the recommendation is
  discarded and the position editor opens with a blank board so the stale game
  state cannot be mistaken for the physical position. The app does not re-suggest
  the same move for a board it can no longer account for. If the
  recommendation is still legal and all of its squares are among those that
  changed, a single unrelated square also moving does not stop it being accepted
  as played.
- The app cannot tell *which* piece moved, only which squares changed, so it
  cannot check that the right piece landed on the destination — only that a legal
  move produces exactly this change set, and that it is the recommended one. A
  board whose position has already drifted from the app's game cannot be repaired
  by changed-square tracking; enter its actual position with **Set position**.
- The engine is a compact 0x88 search, not Stockfish. Its move generator is
  perft-exact and the search reaches depth 9–11 in the ~2 s budget, which is
  enough to see mates, hanging pieces and most short tactics. It is still a small
  engine: in quiet, roughly equal positions several moves score within a few
  centipawns and the one it picks can differ from opening theory (`Ne2` instead of
  `Nf3`, for example). Treat it as a strong club player that is always tactically
  alert, not as an oracle.

## Running locally

The pages use ES modules and a module Web Worker, so they must be served over
HTTP (not opened as files). The camera also requires `localhost` or HTTPS.

```sh
python -m http.server 8765
# then open http://localhost:8765/
```

## Layout

```
index.html          UI shell: camera view, status bar, controls
js/app.js           camera loop, tracking, AR overlay
js/vision.js        board detection & tracking, square sampling
js/track.js         change set -> chess move
js/coach.js         read -> recommend -> verify loop, game state, no DOM
js/engine.js        worker boundary: search -> SAN, legality cross-check
js/engine-board.js  0x88 board, FEN, Zobrist, move generation, make/unmake
js/engine-eval.js   tapered evaluation
js/engine-search.js alpha-beta/PVS/TT/quiescence search
vendor/chess.js     chess.js 0.13.4 (ES module build, vendored)
tests/               synthetic scenes and diagnostic pages
```

## How detection works

1. **Pyramid.** Each frame is converted to grey, blurred once, and reduced to ½
   and ¼ scale, with Sobel magnitudes at each level. At ¼ scale the inner grid has
   averaged away and the board's rim is the strongest structure in the image —
   which is exactly what makes the outer edge findable, and makes the search
   cheap. Levels are tried coarsest first and the search stops the moment a
   candidate is decisive; a score-guided fit is run on the best coarse candidate
   for that reason, because a coarse ridge snap cannot correct a *scale* error.
2. **Hough.** A coarse Hough transform (180 angles, weighted votes) returns the top
   peaks at each level. Up to 56 lines are kept, and peaks that are the same
   physical edge spread over a few degrees (a short edge, a thick line) are merged
   with a deliberately narrow window: wide enough to collapse a fan, narrow enough
   that the four sides of a small board stay four lines.
3. **Families.** The peaks are split into the two perpendicular line families of a
   board grid by weighted angle voting, and every pair of one family is crossed
   with every pair of the other. Pairs too close to hold cells between them are
   dropped first (a board side spans several cells), the pair lists are capped, and
   the resulting quads are capped and then **interleaved by size class**: the
   biggest quads first, the best of the smaller ones between them. Without that a
   table edge or a doorway fills every slot and a board across the room is never
   scored.
4. **Snap.** Each candidate side is snapped onto the strongest long straight
   gradient ridge (a global offset+angle search, immune to the short curved edges
   of pieces), first coarse then at half-pixel resolution. Each side is scored in
   six stretches and the weakest and strongest are dropped, so a hand over part of
   an edge cannot drag it, and a piece standing on it cannot pull it either.
5. **Score.** The 64 cells are sampled at their four corners (pieces sit in the
   middle, not the corners) and the samples are high-passed against their 3×3
   neighbourhood before the two alternating classes are compared. That normal-
   isation cancels uneven lighting and vignetting, which otherwise swamps the
   spread on real cameras. The separation is normalised by an estimate of how much
   contrast this cell size can show — small squares mix their neighbours, so the
   same board scores lower when it is far away — and a board clipped by the frame
   is scored only on the cells that are actually visible. A candidate is judged by
   the strict score, and — if that fails — by the same measurement with the cells
   that fit neither colour removed, at a much higher bar (a *near* board never
   reaches it, a *covered* board does). A score-guided fit (scale, then centre) is
   run once on the best candidate, because a bordered board or a row of pieces
   along an edge can make the strongest ridge the wrong ridge. If everything is
   about to be rejected, the rest of each level's candidate list gets scored
   before giving up: a failed search has already paid for the transforms, so that
   is where extra recall is free.
6. **Track.** Once locked, the grid is *frozen* while the frame is still. On a
   moving frame it is re-fitted from the predicted position (last quad plus the
   smoothed corner velocity), and the fit is accepted on the trimmed score, so a
   hand over the board does not break the lock. The grid only counts as moved when
   it moved by a fifth of a square, and the square sampling grid is *anchored*:
   descriptors are taken on the last confirmed grid and only re-anchored when the
   board itself moved. Between moves the anchor is allowed to follow the board
   (re-basing at the same time), so it never drifts away from the squares while a
   move is being read. Re-detection happens only when the trimmed score also
   collapses, and a detection that lands on the board already held is ignored
   rather than applied.

## Performance

The loop is built so that a frame costs work only in proportion to how much
actually changed. Per frame, measured in desktop Chrome at 480×270 and 720×405
(the two figures are those two sizes):

| what | cost |
| --- | --- |
| frame where nothing moved (thumbnail diff only) | **0.6 / 1.3 ms** |
| the same, end to end in the app, camera readback included | **1.7 / 3.9 ms** |
| moving frame: re-fit the grid + sample 64 squares | **12 / 32 ms** |
| full search: first lock, or after the board is lost | **40 / 58 ms** |
| a board with an arm lying across it | no extra cost |

The search is the only expensive part, and it is not on the per-frame path: while
locked it runs only when the trimmed score also collapses. A still board costs a
thumbnail and nothing else. (These numbers come from a software-rendered Chrome
on a VM and are 2–3× slower than the same code on a phone; the share of each
stage is what is worth reading.)

What made the difference:

- **A still frame skips the vision work entirely.** A quarter-scale thumbnail is
  taken straight from the camera pixels and diffed against the previous frame,
  averaged over 16×16-pixel blocks so sensor noise cancels. If nothing moved, the
  previous square descriptor is reused verbatim — no gradient, no sampling, no
  detection. A piece move or a one-pixel camera nudge is still 15–35 on the same
  scale, so the gate is safe.
- **Gradients are built lazily.** The Sobel maps are only needed for detection
  and ridge snapping, so a frame that is merely tracked pays nothing for them.
- **The search stops at the coarser scale.** A full-resolution Hough is ~10× the
  quarter-scale one, so a decisive candidate at ¼ or ½ scale ends the search
  there; the score-guided fit at that level is what makes the coarse candidate
  decisive in the first place.
- **Buffers rotate instead of allocating.** Two scratch sets per resolution are
  reused, so a running camera generates no garbage and the collector never has a
  reason to interrupt the loop.
- **Square sampling is affine per square.** Four corner projections plus a
  bilinear map inside each cell replaced a per-sample homography transform and
  array allocation — that alone was 22 ms of the 30 ms frame.
- **The overlay uses a dark under-stroke instead of `shadowBlur`.** A canvas blur
  pass per frame is several times the cost of one extra stroke.
- **Frames are consumed as the camera produces them** (`requestVideoFrameCallback`)
  rather than on every animation frame, so no frame is drawn or sampled twice.
- **A covered board costs nothing extra.** Tracking a board with an arm lying on
  it is the same cost as tracking a clear one: the trimmed score is computed
  lazily, only when the strict one is low, and a hand never triggers a re-search
  (a re-search that cannot succeed would run every frame).

## Tests

All of it runs in the browser against synthetic scenes rendered with Canvas2D —
no phone required.

- `tests/harness.html` — the main validation run:
  - 14 perspective poses (tilt, size, border, lighting gradient, noise, clutter),
  - orientation for both sides (a1/h1 parity),
  - stability on a static frame,
  - reading 20 consecutive moves of a real opening,
  - detection with a hand over a corner, tracking through a pan with a whole
    forearm lying across the board, a move played under a hand, a move played out
    of a hand, and four scenes with no board at all (which must *not* lock),
  - the same board in every corner of the frame at three sizes and two rotations,
    which must be found *and* named the right way round,
  - the recommendation loop: a move is suggested, played on the board and must be
    read back as *the suggested move*, with the arrow gone in the same read; a
    whole sequence of opponent/reply pairs; playing a different move; a hand over
    the board while the move is made underneath it; a board change that no legal
    move explains; the same loop with the player on Black; and the reported bug
    itself — a recommended king move, and castling (four changed squares).

  Current result, at 480×270 / 720×405 / 405×720: **detection 14/14** (mean 33–44 ms
  per detection, readback included), **orientation correct both sides**,
  **corner occluded 6/6**, **pan + arm 18/18 followed, 0 locks lost, worst corner
  error 0.3–0.4 % of board width**, **move reading 20/20**, **moves under/out of a
  hand read correctly**, **false locks 0/4**, **board anywhere 29/30, 30/30, 30/30**,
  **recommendation loop 39/39**.

- `tests/placement.html` — how much of the frame a board may occupy and where it
  may sit. Group A places the board fully inside the frame (by its real bounding
  box, so tilt cannot push a corner out) at 18–85 % of the short side, nine
  positions, three rotations, plus a steeper tilt; group B crops 3 % of it by an
  edge; group C crops 20 %.

  Current result at 480×360 (equivalent to a board 65–306 px across in a frame the
  app actually processes):

  | board size | found |
  | --- | --- |
  | 85 % of the short side | 9/9 |
  | 70 % | 27/27 |
  | 50 % | 30/30 |
  | 35 % | 27/27 |
  | 25 % | 20/27 |
  | 18 % | 1/27 |

  Group B 13/18, group C 0/6. At 720×405 and 405×720 the same sweep gives the same
  shape (25 % improves to 26/27 and 25/27; 18 % stays hopeless), which is why the
  README states the limit in pixels per square rather than as a percentage.

- `tests/perf.html` — per-stage timing at any resolution, plus the motion-gate
  calibration table (identical frame / re-seeded noise / 1 px / 2 px / 6 px shift
  / a moved pawn).
- `tests/_place_debug.html` — one pose at a time: the ground-truth score, the Hough
  lines near each board side, the candidate quads and what `detectQuad` returns.
- `tests/_det_perf.html` — what each pyramid level costs (Hough, quads, search) and
  the score of its candidates, which is how the search budget was chosen.
- `tests/_hand.html` — the "move under a hand" case frame by frame, with the change
  set, the grid shift and the descriptor diff printed for each frame.
- `tests/engine.html` — engine sanity checks (mate in one, legal replies, timing).

## A note on the economic part of "best move"

The suggestion is computed only for the side selected in the UI, and only while
it is that side's turn. The engine runs in a worker for a fixed budget (~1.8 s);
the camera loop keeps running meanwhile, and an answer that arrives after the
position has changed (the user moved before the arrow appeared) is discarded by
request id rather than drawn. When the opponent moves, the app spends the next
thinking period on your reply. When you move, it does not think at all — it
verifies the move against the arrow and goes back to watching the board.
