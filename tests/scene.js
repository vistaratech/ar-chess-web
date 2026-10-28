/*
 * tests/scene.js — synthetic camera frames for validating the vision pipeline
 * without a phone. Renders a perspective chessboard + pieces in Canvas2D, with
 * optional border, lighting gradient, clutter and sensor noise.
 */

import { solveHomography, project } from '../js/vision.js';

const LIGHT = [240, 217, 181];
const DARK = [181, 136, 99];
const BORDER = [92, 64, 51];

/** Build a plausible hand-held camera pose for the board. */
export function makePose(w, h, opts = {}) {
  const {
    cx = w * 0.5, cy = h * 0.5, size = Math.min(w, h) * 0.78,
    rot = 0, tilt = 0.35, skew = 0, flip = false,
  } = opts;
  const base = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
  const pts = base.map(([x, y]) => {
    const f = 1 - tilt * ((y + 1) / 2); // top edge foreshortened
    let px = x * f;
    let py = y * (1 - tilt * 0.15 * ((y + 1) / 2));
    px += skew * y;
    const c = Math.cos(rot), s = Math.sin(rot);
    return [cx + (px * c - py * s) * size * 0.5, cy + (px * s + py * c) * size * 0.5];
  });
  return flip ? [pts[2], pts[3], pts[0], pts[1]] : pts;
}

/** Draw a FEN position into a perspective quad. */
export function renderScene(ctx, { w, h, fen, quad, border = 0.03, light = 0, noise = 0, clutter = 0, seed = 1 }) {
  let s = seed >>> 0;
  const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);

  // table
  ctx.fillStyle = '#3a3330';
  ctx.fillRect(0, 0, w, h);
  for (let i = 0; i < clutter; i++) {
    ctx.fillStyle = `rgba(${60 + rnd() * 120 | 0},${50 + rnd() * 100 | 0},${40 + rnd() * 90 | 0},0.85)`;
    ctx.fillRect(rnd() * w, rnd() * h, 10 + rnd() * w * 0.25, 6 + rnd() * h * 0.2);
  }

  // outer frame (a wooden border wider than the playing area)
  if (border > 0) {
    const cx = quad.reduce((a, p) => a + p[0], 0) / 4;
    const cy = quad.reduce((a, p) => a + p[1], 0) / 4;
    const outer = quad.map(([x, y]) => [cx + (x - cx) * (1 + border * 2), cy + (y - cy) * (1 + border * 2)]);
    ctx.fillStyle = `rgb(${BORDER.join(',')})`;
    poly(ctx, outer);
    ctx.fill();
  }

  const H = solveHomography([[0, 0], [8, 0], [8, 8], [0, 8]], [quad[3], quad[2], quad[1], quad[0]]);
  for (let r = 0; r < 8; r++) {
    for (let f = 0; f < 8; f++) {
      const c = (f + r) & 1 ? LIGHT : DARK; // a1 (0,0) is dark
      ctx.fillStyle = `rgb(${c.join(',')})`;
      poly(ctx, [[f, r], [f + 1, r], [f + 1, r + 1], [f, r + 1]].map(([x, y]) => project(H, x, y)));
      ctx.fill();
    }
  }

  // pieces from FEN
  if (fen) {
    const rows = fen.split(' ')[0].split('/');
    for (let row = 0; row < 8; row++) {
      let file = 0;
      for (const ch of rows[row]) {
        if (/\d/.test(ch)) { file += Number(ch); continue; }
        const rank = 8 - row;
        const f = file, r = rank - 1;
        const c = project(H, f + 0.5, r + 0.5);
        const a = project(H, f + 0.1, r + 0.1), b = project(H, f + 0.9, r + 0.1);
        const size = Math.hypot(b[0] - a[0], b[1] - a[1]);
        drawPiece(ctx, c[0], c[1], size * 0.82, ch);
        file++;
      }
    }
  }

  // lighting gradient
  if (light) {
    const g = ctx.createRadialGradient(w * 0.3, h * 0.25, 10, w * 0.3, h * 0.25, w * 0.9);
    g.addColorStop(0, `rgba(255,255,235,${light})`);
    g.addColorStop(1, 'rgba(0,0,0,0.35)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
  }

  // sensor noise
  if (noise) {
    const img = ctx.getImageData(0, 0, w, h);
    const d = img.data;
    for (let i = 0; i < d.length; i += 4) {
      const n = (rnd() - 0.5) * noise;
      d[i] += n; d[i + 1] += n; d[i + 2] += n;
    }
    ctx.putImageData(img, 0, 0);
  }
}

function poly(ctx, pts) {
  ctx.beginPath();
  pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
  ctx.closePath();
}

const GLYPH = { p: 'p', n: 'n', b: 'b', r: 'r', q: 'q', k: 'k' };

function drawPiece(ctx, x, y, size, ch) {
  const isWhite = ch === ch.toUpperCase();
  const t = GLYPH[ch.toLowerCase()];
  ctx.save();
  ctx.translate(x, y);
  ctx.beginPath();
  ctx.arc(0, 0, size * 0.42, 0, Math.PI * 2);
  ctx.fillStyle = isWhite ? '#f7f4ec' : '#1a1a1a';
  ctx.fill();
  ctx.lineWidth = Math.max(1, size * 0.06);
  ctx.strokeStyle = isWhite ? '#2b2b2b' : '#e8e8e8';
  ctx.stroke();
  ctx.fillStyle = isWhite ? '#1a1a1a' : '#f7f4ec';
  ctx.font = `700 ${size * 0.5}px system-ui,sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(t.toUpperCase(), 0, size * 0.02);
  ctx.restore();
}
