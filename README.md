# AR Chess

Point a phone at a real chessboard. The board is found and tracked automatically —
no calibration taps — and the engine's best next move is drawn on the board as an
arrow.

Live: <https://ar-chess-web.vercel.app>

## What it does

- **Automatic board detection.** No calibration step. As soon as the camera opens
  the app looks for the board and outlines it.
- **Continuous tracking.** The outline follows the board while the phone moves,
  rotates or changes angle. The local re-fit is predicted from the last few
  frames, so a pan does not lag a frame behind; a bigger change re-runs the full
  search.
- **Tolerates hands and arms on the board.** The board score is measured twice:
  strictly over all 64 cells, and again with the cells that fit neither square
  colour dropped. An arm lying across the board ruins the first and barely dents
  the second, so tracking stays glued while somebody moves pieces, and a move
  played *under* a resting hand is read as soon as the hand lifts.
- **Move reading.** After the board has been still for two frames, the squares
  that changed appearance are matched against the legal moves of the current
  position, and the move is played in the app's own game state.
- **AR suggestion.** The engine (alpha-beta, quiescence, iterative deepening, in a
  Web Worker) returns the best move for the side to move; it is drawn as an arrow
  with the destination square ringed and the evaluation in the status bar.
- **Your side.** With "I play Black" selected the app expects the board to be seen
  from Black's side of the table and names the squares accordingly.

Demo without a camera: **`?demo=1`** renders a synthetic board that plays a short
opening, so the whole pipeline can be watched on a desktop.

## Honest limits

- The app reads **moves**, not positions. It starts from the initial position and
  keeps its own game state in step by watching which squares change. Pointing it
  at a random mid-game board and expecting the position to be recognised does not
  work: that needs a trained piece-recognition model, which this project does not
  ship. Use **Resync** to return to the start position.
- Detection is a classical computer-vision pipeline (Hough lines, pyramid,
  colour-parity scoring, ridge snapping), not a neural network. It is reliable for
  a visible board with reasonable contrast and light; it can fail on extreme
  perspective (a strongly foreshortened far edge), heavy clutter, or when the
  board fills none of the frame.
- **The first lock wants most of the board.** A hand or a forearm over a corner or
  an edge is fine (6/6 poses in the test suite), but if half the board is covered
  at the moment the camera opens the app keeps searching until it can see enough
  of it. Once locked, covering the board does not drop the lock.
- Pieces are detected as *changed squares*, not identified. A move is only
  reported when the change set matches exactly one legal move well enough. A hand
  crossing the board is not treated as a move and does not throw away the
  reference either: the app shows "Hand over the board — waiting for a clear view"
  and reads the move underneath it when the board is clear. (If a large change
  stays put for a few seconds it is taken as a new position and the app asks for a
  resync instead, so it cannot wait forever.)
- The engine searches for a fixed time budget (~1.8 s), which is roughly depth 3–4
  with this move generator. It plays sensibly and finds mates, but it is not a
  strong engine.

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
js/app.js           camera loop, tracking, move reading, AR overlay
js/vision.js        board detection & tracking, square sampling
js/track.js         change set -> chess move
js/engine.js        search engine (module worker)
vendor/chess.js     chess.js 0.13.4 (ES module build, vendored)
tests/               synthetic scenes and diagnostic pages
```

## How detection works

1. **Pyramid.** Each frame is converted to grey, blurred once, and reduced to ½
   and ¼ scale, with Sobel magnitudes at each level. At ¼ scale the inner grid has
   averaged away and the board's rim is the strongest structure in the image —
   which is exactly what makes the outer edge findable, and makes the search
   cheap.
2. **Hough.** A coarse Hough transform (180 angles, weighted votes) returns the top
   peaks at each level.
3. **Families.** The peaks are split into the two perpendicular line families of a
   board grid by weighted angle voting, and every pair of one family is crossed
   with every pair of the other. Pairs closer than a fifth of the frame are
   dropped first: a board side spans several cells.
4. **Snap.** Each candidate side is snapped onto the strongest long straight
   gradient ridge (a global offset+angle search, immune to the short curved edges
   of pieces), first coarse then at half-pixel resolution. Each side is scored in
   six stretches and the weakest and strongest are dropped, so a hand over part of
   an edge cannot drag it, and a piece standing on it cannot pull it either.
5. **Score.** The 64 cells are sampled at their four corners (pieces sit in the
   middle, not the corners) and the samples are high-passed against their 3×3
   neighbourhood before the two alternating classes are compared. That normal-
   isation cancels uneven lighting and vignetting, which otherwise swamps the
   spread on real cameras. A candidate is judged by the strict score, and — if
   that fails — by the same measurement with the cells that fit neither colour
   removed, at a much higher bar (a *near* board never reaches it, a *covered*
   board does). A score-guided fit (scale, then centre) is run once on the best
   candidate, because a bordered board or a row of pieces along an edge can make
   the strongest ridge the wrong ridge.
6. **Track.** Once locked, the grid is *frozen* while the frame is still. On a
   moving frame it is re-fitted from the predicted position (last quad plus the
   smoothed corner velocity), and the fit is accepted on the trimmed score, so a
   hand over the board does not break the lock. The grid only moves when the fit
   actually moved by a whole pixel — re-fitting a static board is what makes
   square descriptors wobble. Re-detection happens only when the trimmed score
   also collapses, and a detection that lands on the board already held is
   ignored rather than applied.

## Performance

The loop is built so that a frame costs work only in proportion to how much
actually changed. Measured at 640×360 in a desktop Chrome, per frame:

| what | before | after |
| --- | --- | --- |
| frame where nothing moved | 28 ms | **0.2 ms** |
| frame with a piece/camera change | 28 ms | **2.6 ms** |
| the same, with an arm over the board | — | **2.6 ms** |
| first lock (search + refine) | ~40 ms | **11 ms** |
| 14-pose detection suite, mean | 71 ms | **37–48 ms** |

(28 ms was `prepare` + the 64-square descriptor, which the old loop computed on
every processed frame; 0.2 ms is a still frame that only diffs a thumbnail. The
moving frame grew from 1.6 ms to 2.6 ms because the grid is now re-fitted on every
moving frame instead of only when the score had already degraded — that is what
keeps the overlay glued to the board during a pan — and it includes building the
full-resolution gradient the fit needs. 30 fps still costs under 8 % of a core.)

What made the difference:

- **A still frame skips the vision work entirely.** A quarter-scale thumbnail is
  taken straight from the camera pixels and diffed against the previous frame,
  averaged over 16×16-pixel blocks so sensor noise cancels. If nothing moved, the
  previous square descriptor is reused verbatim — no gradient, no sampling, no
  detection. A piece move or a one-pixel camera nudge is still 15–35 on the same
  scale, so the gate is safe.
- **Gradients are built lazily.** The Sobel maps are only needed for detection
  and ridge snapping, so a frame that is merely tracked pays nothing for them.
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
  it is the same 2.6 ms as tracking a clear one: the trimmed score is computed
  lazily, only when the strict one is low, and a hand never triggers a re-search
  (a re-search that cannot succeed would run every frame at ~30 ms).

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
    of a hand, and four scenes with no board at all (which must *not* lock).

  Current result, identical at 480×270, 720×405 and 405×720: **detection 14/14**
  (mean 37–48 ms per detection), **corner occluded 6/6**, **pan + arm 18/18
  followed, 0 locks lost, worst corner error 0.3–1.4 % of board width**,
  **move reading 20/20**, **moves under/out of a hand read correctly**,
  **false locks 0/4**.

- `tests/perf.html` — per-stage timing at any resolution, plus the motion-gate
  calibration table (identical frame / re-seeded noise / 1 px / 2 px / 6 px shift
  / a moved pawn).

- `tests/debug7.html` — per-pose candidate table (raw/snap error, score, gap) and
  a Hough line dump.
- `tests/debug9.html` — per-square descriptor differences for a sequence of moves;
  the tool that showed why a white pawn on a light square needed a shape term.
- `tests/debug10.html` — renderer determinism and grid drift.
- `tests/engine.html` — engine sanity checks (mate in one, legal replies, timing).

## A note on the economic part of "best move"

The suggestion is computed for whichever side is to move and is only drawn when
that side is the one selected in the UI, so the arrow is your move, not the
opponent's.
