/*
 * vision.js — chessboard detection, tracking and square sampling.
 *
 * Pure math over RGBA buffers, so the whole pipeline can be exercised with
 * synthetic frames (see tests/harness.html) without a camera.
 *
 * Coordinates: board space is (file, rank) with (0,0) = a1 and (8,8) the far
 * corner of h8. Image space is pixels of the buffer passed to `update`.
 */

export const BOARD = 8;

/* ------------------------------------------------------------------ */
/* homography                                                          */
/* ------------------------------------------------------------------ */

/** Solve the 3x3 homography mapping 4 src points to 4 dst points. */
export function solveHomography(src, dst) {
  const A = [];
  for (let i = 0; i < 4; i++) {
    const [x, y] = src[i];
    const [u, v] = dst[i];
    A.push([x, y, 1, 0, 0, 0, -u * x, -u * y, u]);
    A.push([0, 0, 0, x, y, 1, -v * x, -v * y, v]);
  }
  for (let i = 0; i < 8; i++) {
    let p = i;
    for (let r = i + 1; r < 8; r++) if (Math.abs(A[r][i]) > Math.abs(A[p][i])) p = r;
    if (Math.abs(A[p][i]) < 1e-9) return null;
    if (p !== i) { const t = A[i]; A[i] = A[p]; A[p] = t; }
    const inv = 1 / A[i][i];
    for (let c = i; c < 9; c++) A[i][c] *= inv;
    for (let r = 0; r < 8; r++) {
      if (r === i) continue;
      const f = A[r][i];
      if (!f) continue;
      for (let c = i; c < 9; c++) A[r][c] -= f * A[i][c];
    }
  }
  const h = [0, 0, 0, 0, 0, 0, 0, 0, 1];
  for (let i = 0; i < 8; i++) h[i] = A[i][8];
  return h;
}

export function project(h, x, y) {
  const w = h[6] * x + h[7] * y + h[8];
  if (!w || !isFinite(w)) return null;
  return [(h[0] * x + h[1] * y + h[2]) / w, (h[3] * x + h[4] * y + h[5]) / w];
}

export function invert3(m) {
  const [a, b, c, d, e, f, g, h, i] = m;
  const A = e * i - f * h, B = f * g - d * i, K = d * h - e * g;
  const det = a * A + b * B + c * K;
  if (!det || !isFinite(det)) return null;
  return [
    A / det, (c * h - b * i) / det, (b * f - c * e) / det,
    B / det, (a * i - c * g) / det, (c * d - a * f) / det,
    K / det, (b * g - a * h) / det, (a * e - b * d) / det,
  ];
}

/* ------------------------------------------------------------------ */
/* image helpers                                                       */
/* ------------------------------------------------------------------ */

export function grayFromRGBA(rgba, w, h) {
  const out = new Float32Array(w * h);
  for (let i = 0, p = 0; i < out.length; i++, p += 4) {
    out[i] = 0.299 * rgba[p] + 0.587 * rgba[p + 1] + 0.114 * rgba[p + 2];
  }
  return out;
}

function blur121(src, w, h) {
  const tmp = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      const l = src[row + (x > 0 ? x - 1 : 0)];
      const c = src[row + x];
      const r = src[row + (x < w - 1 ? x + 1 : x)];
      tmp[row + x] = (l + 2 * c + r) * 0.25;
    }
  }
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const up = (y > 0 ? y - 1 : 0) * w;
    const row = y * w;
    const down = (y < h - 1 ? y + 1 : y) * w;
    for (let x = 0; x < w; x++) {
      out[row + x] = (tmp[up + x] + 2 * tmp[row + x] + tmp[down + x]) * 0.25;
    }
  }
  return out;
}

function sobelMagnitude(src, w, h) {
  const out = new Float32Array(w * h);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const tl = src[i - w - 1], tc = src[i - w], tr = src[i - w + 1];
      const ml = src[i - 1], mr = src[i + 1];
      const bl = src[i + w - 1], bc = src[i + w], br = src[i + w + 1];
      const gx = (tr + 2 * mr + br) - (tl + 2 * ml + bl);
      const gy = (bl + 2 * bc + br) - (tl + 2 * tc + tr);
      out[i] = Math.sqrt(gx * gx + gy * gy);
    }
  }
  return out;
}

/** Blur + edge magnitude, computed once per frame. */
export function prepare(grayIn, w, h) {
  const gray = blur121(grayIn, w, h);
  return { gray, mag: sobelMagnitude(gray, w, h) };
}

function percentileFromHistogram(hist, total, q) {
  let acc = 0;
  const target = total * q;
  for (let i = 0; i < hist.length; i++) {
    acc += hist[i];
    if (acc >= target) return i;
  }
  return hist.length - 1;
}

function sampleBilinear(src, w, h, x, y) {
  if (!(x >= 0 && y >= 0 && x <= w - 1 && y <= h - 1)) return null;
  const x0 = x | 0, y0 = y | 0;
  const x1 = x0 < w - 1 ? x0 + 1 : x0;
  const y1 = y0 < h - 1 ? y0 + 1 : y0;
  const fx = x - x0, fy = y - y0;
  const a = src[y0 * w + x0], b = src[y0 * w + x1];
  const c = src[y1 * w + x0], d = src[y1 * w + x1];
  return (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy;
}

/* ------------------------------------------------------------------ */
/* Hough lines                                                         */
/* ------------------------------------------------------------------ */

export function houghLines(mag, w, h, maxLines = 20) {
  const nT = 180;   // 1 degree, enough: snapQuad refines sub-pixel
  const dRho = 2;
  const maxRho = Math.hypot(w, h);
  const nR = Math.ceil((2 * maxRho) / dRho) + 2;
  const acc = new Float32Array(nT * nR);

  const hist = new Uint32Array(256);
  let total = 0;
  for (let i = 0; i < mag.length; i++) {
    const v = mag[i] | 0;
    if (v > 0) { hist[v > 255 ? 255 : v]++; total++; }
  }
  const thr = Math.max(20, percentileFromHistogram(hist, total, 0.93));

  const px = [], py = [], pw = [];
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const m = mag[y * w + x];
      if (m < thr) continue;
      px.push(x); py.push(y); pw.push(Math.min(m, 800));
    }
  }
  if (px.length < 16) return [];

  const cos = new Float32Array(nT), sin = new Float32Array(nT);
  for (let t = 0; t < nT; t++) {
    const a = (t * Math.PI) / nT;
    cos[t] = Math.cos(a); sin[t] = Math.sin(a);
  }
  for (let t = 0; t < nT; t++) {
    const c = cos[t], s = sin[t], base = t * nR;
    for (let k = 0; k < px.length; k++) {
      const rho = ((px[k] * c + py[k] * s + maxRho) / dRho) | 0;
      acc[base + rho] += pw[k];
    }
  }

  let max = 0;
  for (let i = 0; i < acc.length; i++) if (acc[i] > max) max = acc[i];
  if (max <= 0) return [];

  const peaks = [];
  const floor = max * 0.12;
  for (let t = 0; t < nT; t++) {
    const tm = (t + nT - 1) % nT, tp = (t + 1) % nT;
    const base = t * nR, bm = tm * nR, bp = tp * nR;
    for (let r = 1; r < nR - 1; r++) {
      const v = acc[base + r];
      if (v < floor) continue;
      if (v < acc[base + r - 1] || v < acc[base + r + 1]) continue;
      if (v < acc[bm + r] || v < acc[bp + r]) continue;
      peaks.push({ theta: (t * 180) / nT, rho: r * dRho - maxRho, votes: v });
    }
  }
  peaks.sort((a, b) => b.votes - a.votes);

  const kept = [];
  for (const p of peaks) {
    let ok = true;
    for (const q of kept) {
      let dT = Math.abs(p.theta - q.theta);
      if (dT > 90) dT = 180 - dT;
      if (dT <= 1 && Math.abs(p.rho - q.rho) <= 6) { ok = false; break; }
    }
    if (ok) kept.push(p);
    if (kept.length >= maxLines) break;
  }
  return kept;
}

function lineAngleDiff(a, b) {
  let d = Math.abs(a.theta - b.theta) % 180;
  if (d > 90) d = 180 - d;
  return d;
}

function intersectLines(l1, l2) {
  const t1 = (l1.theta * Math.PI) / 180, t2 = (l2.theta * Math.PI) / 180;
  const c1 = Math.cos(t1), s1 = Math.sin(t1);
  const c2 = Math.cos(t2), s2 = Math.sin(t2);
  const det = c1 * s2 - s1 * c2;
  if (Math.abs(det) < 0.2) return null;
  return [(l1.rho * s2 - l2.rho * s1) / det, (l2.rho * c1 - l1.rho * c2) / det];
}

/* ------------------------------------------------------------------ */
/* quad geometry + scoring                                             */
/* ------------------------------------------------------------------ */

const BOARD_SRC = [[0, 0], [BOARD, 0], [BOARD, BOARD], [0, BOARD]];

function quadArea(q) {
  let a = 0;
  for (let i = 0; i < 4; i++) {
    const [x1, y1] = q[i], [x2, y2] = q[(i + 1) % 4];
    a += x1 * y2 - x2 * y1;
  }
  return Math.abs(a) / 2;
}

function isConvex(q) {
  let sign = 0;
  for (let i = 0; i < 4; i++) {
    const [ax, ay] = q[i], [bx, by] = q[(i + 1) % 4], [cx, cy] = q[(i + 2) % 4];
    const cross = (bx - ax) * (cy - by) - (by - ay) * (cx - bx);
    if (Math.abs(cross) < 1e-6) return false;
    const s = Math.sign(cross);
    if (sign === 0) sign = s;
    else if (s !== sign) return false;
  }
  return true;
}

function orderByAngle(pts) {
  const cx = (pts[0][0] + pts[1][0] + pts[2][0] + pts[3][0]) / 4;
  const cy = (pts[0][1] + pts[1][1] + pts[2][1] + pts[3][1]) / 4;
  return pts.slice().sort((a, b) => Math.atan2(a[1] - cy, a[0] - cx) - Math.atan2(b[1] - cy, b[0] - cx));
}

export function validQuad(q, w, h) {
  const area = quadArea(q);
  if (area < w * h * 0.05 || area > w * h * 1.05) return false;
  if (!isConvex(q)) return false;
  const m = 0.08;
  for (const [x, y] of q) {
    if (x < -w * m || y < -h * m || x > w * (1 + m) || y > h * (1 + m)) return false;
  }
  let mn = Infinity, mx = 0;
  for (let i = 0; i < 4; i++) {
    const [x1, y1] = q[i], [x2, y2] = q[(i + 1) % 4];
    const len = Math.hypot(x2 - x1, y2 - y1);
    mn = Math.min(mn, len); mx = Math.max(mx, len);
  }
  if (mn < Math.min(w, h) * 0.16) return false;
  if (mx / mn > 2.8) return false;
  return true;
}

/**
 * Rotate a cyclic quad so it starts at the top-left-most corner.
 *
 * The homography only makes sense for a *consistent* corner correspondence:
 * feeding the same four corners in a rotated order maps the 8x8 grid onto a
 * rotated quad, which does not line up with the real squares on a trapezoid.
 */
export function canonicalQuad(quad) {
  let k = 0, best = Infinity;
  for (let i = 0; i < 4; i++) {
    const v = quad[i][0] + quad[i][1];
    if (v < best) { best = v; k = i; }
  }
  return [quad[k], quad[(k + 1) % 4], quad[(k + 2) % 4], quad[(k + 3) % 4]];
}

/**
 * How chessboard-like is this quad?
 *
 * Sample the four *corners* of every cell (pieces sit in the middle, not in the
 * corners), take the median so a single piece spilling over cannot lie, then
 * ask how cleanly the 64 samples split into the two alternating colours.
 *
 * A correct quad gives a large separation with near-zero spread inside each
 * class; a quad that is shifted or scaled wrongly mixes board colours with
 * pieces and the spread explodes. The objective is flat within a couple of
 * pixels of the truth, which makes it easy to optimise.
 */
export function scoreQuad(prepared, w, h, quad) {
  const { gray } = prepared;
  quad = canonicalQuad(quad);
  const H = solveHomography(BOARD_SRC, quad);
  if (!H) return null;

  const off = 0.18;
  const pts = [[off, off], [1 - off, off], [1 - off, 1 - off], [off, 1 - off]];
  const vals = new Float32Array(64);
  const four = [0, 0, 0, 0];

  for (let r = 0; r < BOARD; r++) {
    for (let f = 0; f < BOARD; f++) {
      for (let i = 0; i < 4; i++) {
        const p = project(H, f + pts[i][0], r + pts[i][1]);
        const v = p ? sampleBilinear(gray, w, h, p[0], p[1]) : null;
        if (v === null) return null;
        four[i] = v;
      }
      four.sort((a, b) => a - b);
      vals[r * 8 + f] = (four[1] + four[2]) * 0.5;
    }
  }

  let sa = 0, sb = 0, qa = 0, qb = 0;
  for (let i = 0; i < 64; i++) {
    const v = vals[i];
    if ((i % 8 + (i >> 3)) & 1) { sb += v; qb += v * v; }
    else { sa += v; qa += v * v; }
  }
  const mA = sa / 32, mB = sb / 32;
  const sdA = Math.sqrt(Math.max(0, qa / 32 - mA * mA));
  const sdB = Math.sqrt(Math.max(0, qb / 32 - mB * mB));
  const sep = Math.abs(mA - mB);

  return { h: H, sep, sdA, sdB, mA, mB, score: sep / (1 + sdA + sdB) };
}

/* ------------------------------------------------------------------ */
/* detection                                                           */
/* ------------------------------------------------------------------ */

function quadFromLines(lines, idx, w, h) {
  const L = idx.map((i) => lines[i]);
  // two pairs of near-parallel opposite sides
  const pairs = [[0, 1, 2, 3], [0, 2, 1, 3], [0, 3, 1, 2]];
  for (const [a, b, c, d] of pairs) {
    if (lineAngleDiff(L[a], L[b]) > 25) continue;
    if (lineAngleDiff(L[c], L[d]) > 25) continue;
    if (lineAngleDiff(L[a], L[c]) < 35) continue;
    const corners = [
      intersectLines(L[a], L[c]),
      intersectLines(L[a], L[d]),
      intersectLines(L[b], L[d]),
      intersectLines(L[b], L[c]),
    ];
    if (corners.some((p) => !p)) continue;
    const q = orderByAngle(corners);
    if (!validQuad(q, w, h)) continue;
    return q;
  }
  return null;
}

/**
 * Find the most chessboard-looking quad.
 *
 * Hough gives candidate quads that are within a few pixels of the truth but
 * rarely exact, and the colour score is sharply peaked, so the largest
 * candidates are polished first and then compared.
 *
 * @returns {{quad: number[][], score: number, sep: number}|null}
 */
export function detectQuad(prepared, w, h) {
  const cands = candidateQuads(prepared, w, h);
  if (!cands.length) return null;

  let best = null;
  const tried = [];
  for (const c of cands) {
    if (tried.some((t) => meanCornerShift(t, c.quad) < w * 0.03)) continue;
    tried.push(c.quad);
    // snap to the ridge under each side, then judge by colour consistency
    let quad = snapQuad(prepared.mag, w, h, c.quad, 10) || c.quad;
    const again = snapQuad(prepared.mag, w, h, quad, 3);
    if (again && validQuad(again, w, h)) quad = again;
    if (!validQuad(quad, w, h)) continue;
    const sc = scoreQuad(prepared, w, h, quad);
    if (sc && (!best || sc.score > best.score)) best = { quad, score: sc.score, sep: sc.sep };
    if (tried.length >= 6) break;
  }

  if (!best || best.score < 5 || best.sep < 14) return null;
  return best;
}

/** Candidate quads from the detected lines, largest first. */
export function candidateQuads(prepared, w, h, maxLines = 14) {
  const lines = houghLines(prepared.mag, w, h, maxLines);
  if (lines.length < 4) return [];
  const n = lines.length;
  const cands = [];
  // all 4-subsets: which lines oppose each other is decided in quadFromLines
  for (let a = 0; a < n; a++) {
    for (let b = a + 1; b < n; b++) {
      for (let c = b + 1; c < n; c++) {
        for (let d = c + 1; d < n; d++) {
          const quad = quadFromLines(lines, [a, b, c, d], w, h);
          if (!quad) continue;
          cands.push({ quad, area: quadArea(quad) });
        }
      }
    }
  }
  cands.sort((x, y) => y.area - x.area);
  return cands;
}

/**
 * Snap one side of the quad onto the strongest *long straight* gradient ridge.
 *
 * Searching offset+angle globally (instead of snapping each sample point
 * independently) is what makes this immune to the short curved edges of pieces
 * sitting near the boundary: the board edge must be strong along its whole length.
 */
function snapLine(mag, w, h, a, b, range = 9) {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const L = Math.hypot(dx, dy);
  if (L < 24) return null;
  const ux = dx / L, uy = dy / L;
  const mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2;
  const half = Math.max(6, L / 2 - 4);
  const stepT = Math.max(2, L / 22);

  let best = null;
  const angles = [0, -0.02, 0.02, -0.04, 0.04, -0.06, 0.06];
  const offsets = [];
  for (let o = -range; o <= range + 0.01; o += range / 6) offsets.push(o);

  for (const ang of angles) {
    const c = Math.cos(ang), s = Math.sin(ang);
    const vx = ux * c - uy * s, vy = ux * s + uy * c;
    const nx = -vy, ny = vx;
    for (const off of offsets) {
      let sum = 0, n = 0;
      for (let t = -half; t <= half; t += stepT) {
        const v = sampleBilinear(mag, w, h, mx + nx * off + vx * t, my + ny * off + vy * t);
        if (v === null) continue;
        sum += Math.min(v, 700); n++;
      }
      if (!n) continue;
      const sc = sum / n;
      if (!best || sc > best.sc) best = { sc, vx, vy, px: mx + nx * off, py: my + ny * off };
    }
  }
  return best;
}

/** Snap all four sides and re-intersect them. */
export function snapQuad(mag, w, h, quad, range = 9) {
  const lines = [];
  for (let i = 0; i < 4; i++) {
    const l = snapLine(mag, w, h, quad[i], quad[(i + 1) % 4], range);
    if (!l) return null;
    lines.push(l);
  }
  const corners = [];
  for (let i = 0; i < 4; i++) {
    const l1 = lines[(i + 3) % 4], l2 = lines[i];
    const det = l1.vx * l2.vy - l1.vy * l2.vx;
    if (Math.abs(det) < 0.35) return null;
    const t = ((l2.px - l1.px) * l2.vy - (l2.py - l1.py) * l2.vx) / det;
    corners.push([l1.px + l1.vx * t, l1.py + l1.vy * t]);
  }
  return corners;
}

/**
 * Refine a quad onto the playing area.
 *
 * Stage 1 (optional) searches scale and offset around the current quad, which
 * is what pulls it off a decorative border onto the playing area.
 * Stage 2 snaps each side onto its gradient ridge for sub-pixel corners.
 * Stage 3 does a short walk uphill on the colour score to polish.
 */
export function refineQuad(prepared, w, h, quad, { inset = false, passes = 2, iters = 3 } = {}) {
  const { mag } = prepared;
  let best = quad.map((p) => p.slice());
  let bestScore = scoreQuad(prepared, w, h, best);
  if (!bestScore) return quad;

  if (inset) {
    const cx = (best[0][0] + best[1][0] + best[2][0] + best[3][0]) / 4;
    const cy = (best[0][1] + best[1][1] + best[2][1] + best[3][1]) / 4;
    const base = best.map((p) => p.slice());
    const size = (Math.hypot(base[1][0] - base[0][0], base[1][1] - base[0][1])
      + Math.hypot(base[2][0] - base[1][0], base[2][1] - base[1][1])) / 2;
    for (const k of [1, 0.98, 0.96, 0.94, 0.92, 0.9, 0.88, 0.86, 0.84, 1.02]) {
      for (const sx of [-0.02, 0, 0.02]) {
        for (const sy of [-0.02, 0, 0.02]) {
          const ox = cx + size * sx, oy = cy + size * sy;
          const cand = base.map(([x, y]) => [ox + (x - ox) * k, oy + (y - oy) * k]);
          if (!validQuad(cand, w, h)) continue;
          const sc = scoreQuad(prepared, w, h, cand);
          if (sc && sc.score > bestScore.score) { best = cand; bestScore = sc; }
        }
      }
    }
  }

  for (let p = 0; p < passes; p++) {
    const snapped = snapQuad(mag, w, h, best, p === 0 ? 8 : 3);
    if (snapped && validQuad(snapped, w, h)) {
      const sc = scoreQuad(prepared, w, h, snapped);
      if (sc && sc.score >= bestScore.score * 0.9) { best = snapped; bestScore = sc; }
    }
  }

  // small uphill walk on the colour score
  for (let round = 0; round < 2; round++) {
    const step = round === 0 ? 1.5 : 0.75;
    let improved = true, guard = 0;
    while (improved && guard++ < iters) {
      improved = false;
      let any = false;
      for (let k = 0; k < 4; k++) {
        let lb = null, ls = bestScore.score, lo = null;
        for (let dx = -1; dx <= 1; dx++) {
          for (let dy = -1; dy <= 1; dy++) {
            if (!dx && !dy) continue;
            const cand = best.map((q) => q.slice());
            cand[k][0] += dx * step;
            cand[k][1] += dy * step;
            if (!validQuad(cand, w, h)) continue;
            const sc = scoreQuad(prepared, w, h, cand);
            if (sc && sc.score > ls) { ls = sc.score; lb = cand; lo = sc; }
          }
        }
        if (lb) { best = lb; bestScore = lo; any = true; }
      }
      improved = any;
    }
  }
  return best;
}

/* ------------------------------------------------------------------ */
/* orientation                                                         */
/* ------------------------------------------------------------------ */

/**
 * Order a convex quad as [nearLeft, nearRight, farRight, farLeft] from the
 * player's point of view (the player sits at the bottom of the frame).
 */
export function orderQuad(quad) {
  const pts = quad.map((p) => p.slice());
  const byY = pts.slice().sort((a, b) => b[1] - a[1]);
  const bottom = [byY[0], byY[1]];
  const nearLeft = bottom[0][0] <= bottom[1][0] ? bottom[0] : bottom[1];
  const nearRight = nearLeft === bottom[0] ? bottom[1] : bottom[0];
  const rest = pts.filter((p) => p !== nearLeft && p !== nearRight);
  const d = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
  const farLeft = d(rest[0], nearLeft) <= d(rest[1], nearLeft) ? rest[0] : rest[1];
  const farRight = farLeft === rest[0] ? rest[1] : rest[0];
  return [nearLeft, nearRight, farRight, farLeft];
}

/** Homography mapping board (file, rank) -> image for the given player side. */
export function boardHomography(quad, side) {
  const [nl, nr, fr, fl] = orderQuad(quad);
  const src = side === 'b'
    ? [[8, 8], [0, 8], [0, 0], [8, 0]]
    : [[0, 0], [8, 0], [8, 8], [0, 8]];
  return solveHomography(src, [nl, nr, fr, fl]);
}

/** Corners of one square, in image space. */
export function cellCorners(H, f, r) {
  return [[f, r], [f + 1, r], [f + 1, r + 1], [f, r + 1]].map(([x, y]) => project(H, x, y));
}

export function cellCenter(H, f, r) {
  return project(H, f + 0.5, r + 0.5);
}

/* ------------------------------------------------------------------ */
/* square descriptors                                                  */
/* ------------------------------------------------------------------ */

/**
 * 64 squares x 3x3 luminance samples, indexed rank-major (a1 = 0).
 * Used for frame-to-frame difference and move inference.
 */
export function describeSquares(gray, w, h, H) {
  const out = new Float32Array(64 * 9);
  const offs = [0.25, 0.5, 0.75];
  for (let r = 0; r < 8; r++) {
    for (let f = 0; f < 8; f++) {
      const base = (r * 8 + f) * 9;
      for (let i = 0; i < 3; i++) {
        for (let j = 0; j < 3; j++) {
          const p = project(H, f + offs[j], r + offs[i]);
          const v = p ? sampleBilinear(gray, w, h, p[0], p[1]) : null;
          out[base + i * 3 + j] = v === null ? 0 : v;
        }
      }
    }
  }
  return out;
}

/** Per-square RMS difference between two descriptors (0..255). */
export function squareDiff(a, b) {
  const out = new Float32Array(64);
  for (let s = 0; s < 64; s++) {
    let acc = 0;
    const base = s * 9;
    for (let k = 0; k < 9; k++) {
      const d = a[base + k] - b[base + k];
      acc += d * d;
    }
    out[s] = Math.sqrt(acc / 9);
  }
  return out;
}

export function median(arr) {
  const a = Array.from(arr).sort((x, y) => x - y);
  return a[a.length >> 1];
}

/* ------------------------------------------------------------------ */
/* tracker                                                             */
/* ------------------------------------------------------------------ */

/**
 * Keeps the board quad locked across frames. A full Hough search runs every
 * few frames; in between the quad is refined locally, which is far cheaper
 * and keeps the AR overlay glued to the board.
 */
export class BoardTracker {
  constructor({ side = 'w', detectEvery = 4 } = {}) {
    this.side = side;
    this.detectEvery = detectEvery;
    this.quad = null;
    this.H = null;
    this.score = 0;
    this.tick = 0;
    this.misses = 0;
    this.redetected = false;
    this.frames = 0;
  }

  reset() {
    this.quad = null;
    this.H = null;
    this.score = 0;
    this.misses = 0;
    this.tick = 0;
  }

  get locked() {
    return !!this.quad;
  }

  /**
   * @param {Uint8ClampedArray} rgba pixels at w x h
   * @returns {{quad:number[][]|null, H:number[]|null, score:number, redetected:boolean}}
   */
  update(rgba, w, h) {
    const prepared = prepare(grayFromRGBA(rgba, w, h), w, h);
    this.frames++;
    this.redetected = false;

    const due = !this.quad || this.tick++ % this.detectEvery === 0;
    if (due) {
      const det = detectQuad(prepared, w, h);
      if (det) {
        this.misses = 0;
        this.redetected = true;
        const close = this.quad && meanCornerShift(this.quad, det.quad) < w * 0.1;
        const base = close ? blendQuad(this.quad, det.quad, 0.5) : det.quad;
        this.quad = refineQuad(prepared, w, h, base, { inset: !close, passes: close ? 1 : 3 });
        this.score = scoreQuad(prepared, w, h, this.quad)?.score || 0;
      } else if (this.quad) {
        this.misses++;
        if (this.misses > 8) this.reset();
      }
    }

    if (this.quad) {
      const refined = refineQuad(prepared, w, h, this.quad, { passes: 1 });
      if (refined && validQuad(refined, w, h)) {
        this.quad = blendQuad(this.quad, refined, 0.6);
        this.score = scoreQuad(prepared, w, h, this.quad)?.score || 0;
      }
    }

    this.H = this.quad ? boardHomography(this.quad, this.side) : null;
    return { quad: this.quad, H: this.H, score: this.score, redetected: this.redetected };
  }
}

function meanCornerShift(a, b) {
  let s = 0;
  for (let i = 0; i < 4; i++) s += Math.hypot(a[i][0] - b[i][0], a[i][1] - b[i][1]);
  return s / 4;
}

function blendQuad(a, b, t) {
  return a.map((p, i) => [p[0] + (b[i][0] - p[0]) * t, p[1] + (b[i][1] - p[1]) * t]);
}
