# AR Chess Assistant (web prototype)

Phone camera la real chessboard paathu, next best move ah AR overlay la kaattum.

## Run panradhu
Camera ku HTTPS (or localhost) venum.

**PC la test:**
    cd ar-chess
    python -m http.server 8000
    # browser la http://localhost:8000 open pannu (webcam use aagum)

**Phone la test:** folder ah Netlify / GitHub Pages / Vercel la deploy pannu (HTTPS kedaikkum), phone browser la open pannu.
chess.js CDN la irundhu load aagudhu, so internet venum.

## Use panradhu
1. Phone ah tripod/stand la fix pannu (handheld tracking illa).
2. "I play White/Black" select pannu.
3. Board oda 4 corners tap pannu: near-left, near-right, far-right, far-left (clockwise).
4. Standard starting position la irundhaa direct ah start. Mid-game na FEN box la FEN potuttu "New game" press pannu.
5. Un turn la green squares + NEXT MOVE label varum. Move pannitu hand edukkunga, app detect pannum.
6. Detect miss aanaa from square, apram to square tap pannu.

## Limits
- 4 corners manual tap (auto board detection illa).
- Frame-difference move detection, piece recognition model illa.
- Engine: depth-3 search (Stockfish illa).
- Fixed camera venum.

## Next (React Native)
Auto corner model + optical-flow tracking + Stockfish + VisionCamera.
