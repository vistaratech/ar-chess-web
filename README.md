# AR Chess

Point a phone at a real chessboard. The board is found and tracked automatically —
no calibration taps — and the engine's best next move is drawn on the board as an
arrow.

Live: <https://ar-chess-web.vercel.app>

## What it does

- **Automatic board detection.** No calibration step. As soon as the camera opens
  the app looks for the board and outlines it.
- **Continuous tracking.** The outline follows the board while the phone moves,
  rotates or changes angle. A camera pan of a few pixels per frame is followed by
  a cheap local re-fit; a bigger change re-runs the full search.
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
- Pieces are detected as *changed squares*, not identified. A move is only
  reported when the change set matches exactly one legal move well enough; a
  hand crossing the board, or moving two pieces at once, is reported as unreadable
  rather than guessed at.
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
   of pieces), first coarse then at half-pixel resolution.
5. **Score.** The 64 cells are sampled at their four corners (pieces sit in the
   middle, not the corners) and the samples are high-passed against their 3×3
   neighbourhood before the two alternating classes are compared. That normal-
   isation cancels uneven lighting and vignetting, which otherwise swamps the
   spread on real cameras.
6. **Track.** Once locked, the grid is *frozen* unless the score degrades. A
   well-locked, still board is never re-fitted — that is what keeps square
   descriptors comparable from frame to frame. Re-detection only happens when the
   score drops, or on a slow heartbeat, and a detection that lands on the board
   already held is ignored rather than applied.

## Tests

All of it runs in the browser against synthetic scenes rendered with Canvas2D —
no phone required.

- `tests/harness.html` — the main validation run:
  - 14 perspective poses (tilt, size, border, lighting gradient, noise, clutter),
  - orientation for both sides (a1/h1 parity),
  - stability on a static frame,
  - reading 20 consecutive moves of a real opening.

  Current result: **detection 14/14**, **move reading 20/20**, ~70 ms per
  detection at 640×360.

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
