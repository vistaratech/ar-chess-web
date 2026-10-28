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

/**
 * RGBA -> luminance. Integer arithmetic (Rec.601 in 8.8 fixed point): the
 * float version cost 1.5 ms per 640x360 frame, this is about a third of that.
 */
export function grayFromRGBA(rgba, w, h) {
  const out = new Float32Array(w * h);
  for (let i = 0, p = 0; i < out.length; i++, p += 4) {
    out[i] = (77 * rgba[p] + 150 * rgba[p + 1] + 29 * rgba[p + 2]) >> 8;
  }
  return out;
}

/**
 * Quarter-scale luminance taken straight from the RGBA buffer, with a diff
 * against the previous frame.
 *
 * This is the cheap "has anything moved" test that lets a still camera skip all
 * of the vision work: four samples per 4x4 block average the sensor noise away,
 * so a genuine change (a piece, a camera nudge) stands out clearly while a
 * static scene compares at exactly zero.
 */
export function thumbFromRGBA(rgba, w, h, prev, prevW, prevH) {
  const tw = Math.max(1, w >> 2), th = Math.max(1, h >> 2);
  const out = new Float32Array(tw * th);
  for (let y = 0; y < th; y++) {
    const r0 = (4 * y) * w, r1 = (4 * y + 2) * w;
    for (let x = 0; x < tw; x++) {
      const c0 = 4 * x, c1 = 4 * x + 2;
      const a = (r0 + c0) * 4, b = (r0 + c1) * 4, c = (r1 + c0) * 4, d = (r1 + c1) * 4;
      const v = (
        (77 * rgba[a] + 150 * rgba[a + 1] + 29 * rgba[a + 2]) +
        (77 * rgba[b] + 150 * rgba[b + 1] + 29 * rgba[b + 2]) +
        (77 * rgba[c] + 150 * rgba[c + 1] + 29 * rgba[c + 2]) +
        (77 * rgba[d] + 150 * rgba[d + 1] + 29 * rgba[d + 2])
      ) / 1024;
      out[y * tw + x] = v;
    }
  }

  // Compare 4x4 thumb blocks (16x16 image pixels). Averaging a block first is
  // what makes this usable on a real sensor: the per-pixel noise of a still
  // camera averages down to a fraction of a level, while a piece or a one-pixel
  // camera nudge still moves a block clearly.
  let worst = 0;
  if (prev && prevW === tw && prevH === th) {
    for (let by = 0; by < th; by += 4) {
      const y1 = Math.min(by + 4, th);
      for (let bx = 0; bx < tw; bx += 4) {
        const x1 = Math.min(bx + 4, tw);
        let s = 0, n = 0;
        for (let y = by; y < y1; y++) {
          const row = y * tw;
          for (let x = bx; x < x1; x++) { s += Math.abs(out[row + x] - prev[row + x]); n++; }
        }
        const m = s / n;
        if (m > worst) worst = m;
      }
    }
  } else {
    worst = Infinity;
  }
  return { thumb: out, tw, th, motion: worst };
}

/* ------------------------------------------------------------------ */
/* per-frame buffers                                                   */
/* ------------------------------------------------------------------ */

/**
 * Two scratch sets per resolution. Two, not one, because a caller may still be
 * reading the descriptor of the previous frame while the next one is being
 * prepared; with a single set that frame's data would be overwritten in place.
 * Everything is reused afterwards, so a running camera allocates nothing per
 * frame and the garbage collector never has a reason to interrupt the loop.
 */
const pools = new Map();

function poolFor(w, h) {
  const key = w + 'x' + h;
  let e = pools.get(key);
  if (e) return e;
  const sw = Math.max(1, w >> 1), sh = Math.max(1, h >> 1);
  const sw4 = Math.max(1, w >> 2), sh4 = Math.max(1, h >> 2);
  e = { w, h, sw, sh, sw4, sh4, next: 0, slots: [] };
  for (let i = 0; i < 2; i++) {
    e.slots.push({
      rgbaGray: new Float32Array(w * h),
      tmp: new Float32Array(w * h),
      gray: new Float32Array(w * h),
      mag: new Float32Array(w * h),
      gray2: new Float32Array(sw * sh),
      mag2: new Float32Array(sw * sh),
      gray4: new Float32Array(sw4 * sh4),
      mag4: new Float32Array(sw4 * sh4),
    });
  }
  pools.set(key, e);
  return e;
}

function darken(rgba, w, h, out) {
  for (let i = 0, p = 0; i < out.length; i++, p += 4) {
    out[i] = (77 * rgba[p] + 150 * rgba[p + 1] + 29 * rgba[p + 2]) >> 8;
  }
  return out;
}

function blur121Into(src, tmp, out, w, h) {
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      const l = src[row + (x > 0 ? x - 1 : 0)];
      const c = src[row + x];
      const r = src[row + (x < w - 1 ? x + 1 : x)];
      tmp[row + x] = (l + 2 * c + r) * 0.25;
    }
  }
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

function halveInto(src, w, h, out, ow, oh) {
  for (let y = 0; y < oh; y++) {
    const s0 = (2 * y) * w, s1 = s0 + w;
    const row = y * ow;
    for (let x = 0; x < ow; x++) {
      const i = 2 * x;
      out[row + x] = 0.25 * (src[s0 + i] + src[s0 + i + 1] + src[s1 + i] + src[s1 + i + 1]);
    }
  }
  return out;
}

function sobelInto(src, out, w, h) {
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

function prepareInto(src, w, h, e, slot) {
  const { sw, sh, sw4, sh4 } = e;
  const gray = blur121Into(src, slot.tmp, slot.gray, w, h);
  const gray2 = halveInto(gray, w, h, slot.gray2, sw, sh);
  const gray4 = halveInto(gray2, sw, sh, slot.gray4, sw4, sh4);
  // Gradients are the expensive part (a full-res Sobel is several ms) and only
  // detection/refinement need them, so they are built on first access: a frame
  // that is merely tracked and sampled pays nothing for them.
  let mag = null, mag2 = null, mag4 = null;
  return {
    gray, sw, sh, gray2, sw4, sh4, gray4,
    get mag() { return mag || (mag = sobelInto(gray, slot.mag, w, h)); },
    get mag2() { return mag2 || (mag2 = sobelInto(gray2, slot.mag2, sw, sh)); },
    get mag4() { return mag4 || (mag4 = sobelInto(gray4, slot.mag4, sw4, sh4)); },
  };
}

/** Prepare a frame from luminance, allocating (tests, one-off analysis). */
export function prepare(grayIn, w, h) {
  const e = poolFor(w, h);
  const slot = {
    tmp: new Float32Array(w * h), gray: new Float32Array(w * h),
    mag: new Float32Array(w * h),
    gray2: new Float32Array(e.sw * e.sh), mag2: new Float32Array(e.sw * e.sh),
    gray4: new Float32Array(e.sw4 * e.sh4), mag4: new Float32Array(e.sw4 * e.sh4),
  };
  return prepareInto(grayIn, w, h, e, slot);
}

/**
 * Prepare a frame straight from the camera's RGBA buffer, writing into the
 * rotating scratch set. The returned buffers stay valid until two more frames
 * have been prepared at the same size.
 */
export function prepareFrame(rgba, w, h) {
  const e = poolFor(w, h);
  const slot = e.slots[e.next++ % e.slots.length];
  darken(rgba, w, h, slot.rgbaGray);
  return prepareInto(slot.rgbaGray, w, h, e, slot);
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

export function sampleBilinear(src, w, h, x, y) {
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
  const a = [0, 0, 0, 0];
  for (let i = 0; i < 4; i++) a[i] = Math.atan2(pts[i][1] - cy, pts[i][0] - cx);
  // insertion sort of four indices by angle (no allocation, no closure)
  const idx = [0, 1, 2, 3];
  for (let i = 1; i < 4; i++) {
    const v = idx[i];
    let j = i - 1;
    while (j >= 0 && a[idx[j]] > a[v]) { idx[j + 1] = idx[j]; j--; }
    idx[j + 1] = v;
  }
  return idx.map((i) => pts[i]);
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
 * The samples are high-passed against their 3x3 neighbourhood before being
 * compared: on a chessboard every cell is surrounded by four cells of the
 * opposite colour and four of its own, so the neighbourhood mean is the neutral
 * level. Dividing by it cancels both the additive and the multiplicative part
 * of uneven lighting and vignetting, which otherwise swamps the spread on real
 * cameras (and in the synthetic scenes with light=0.16).
 *
 * A correct quad gives a large separation with a small spread inside each
 * class; a quad that is shifted or scaled wrongly mixes board colours with
 * pieces and the spread explodes.
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

  // high-pass against the 3x3 neighbourhood
  const norm = new Float32Array(64);
  for (let r = 0; r < 8; r++) {
    for (let f = 0; f < 8; f++) {
      let s = 0, n = 0;
      for (let dr = -1; dr <= 1; dr++) {
        for (let df = -1; df <= 1; df++) {
          const rr = r + dr, ff = f + df;
          if (rr < 0 || rr > 7 || ff < 0 || ff > 7) continue;
          s += vals[rr * 8 + ff]; n++;
        }
      }
      const m = s / n;
      norm[r * 8 + f] = (vals[r * 8 + f] - m) / (Math.abs(m) + 12);
    }
  }

  // Two readings of the same cells.
  //
  // `score` averages all 64 cells. That is the strict one: a quad that is even
  // half a square out of phase loses the alternation everywhere at once, so a
  // wrong quad cannot score, and this is what detection and ranking use.
  //
  // `trim()` repeats the measurement after dropping the cells that do not fit
  // their colour class (two rounds of 1.8 sigma). A hand or an arm lying on the
  // board makes exactly those cells — it is neither light wood nor dark wood —
  // so the trimmed score stays high while the strict one collapses. Tracking
  // uses it, which is what lets the grid stay glued to a board that is partly
  // covered.
  //
  // The trimmed pass is lazy on purpose: detection scores dozens of candidate
  // quads per frame and only needs the strict number to rank them.
  const all = classStats(norm, null);
  const score = all.sep / (all.sdA + all.sdB + 0.04);
  let trimScore = -1;
  return {
    h: H, mA: all.mA, mB: all.mB, sdA: all.sdA, sdB: all.sdB, sep: all.sep, score,
    trim() {
      if (trimScore < 0) trimScore = trimmedScore(norm, all);
      return trimScore;
    },
  };
}

const keepA = new Uint8Array(64);
const keepB = new Uint8Array(64);

/** Colour separation after throwing out the cells that fit neither class. */
function trimmedScore(norm, all) {
  let keep = null;
  let st = all;
  for (let round = 0; round < 2; round++) {
    const nk = round === 0 ? keepA : keepB;
    let n = 0;
    for (let i = 0; i < 64; i++) {
      const odd = ((i % 8) + (i >> 3)) & 1;
      const m = odd ? st.mB : st.mA;
      const sd = Math.max(odd ? st.sdB : st.sdA, 0.03);
      const on = Math.abs(norm[i] - m) <= 1.8 * sd ? 1 : 0;
      nk[i] = on;
      n += on;
    }
    if (n < 40) break;
    keep = nk;
    st = classStats(norm, keep);
  }
  if (!keep) return all.sep / (all.sdA + all.sdB + 0.04);
  return st.sep / (st.sdA + st.sdB + 0.04);
}

/** Mean/spread of the two alternating cell classes, over the kept cells. */
function classStats(norm, keep) {
  let sa = 0, sb = 0, qa = 0, qb = 0, na = 0, nb = 0;
  for (let i = 0; i < 64; i++) {
    if (keep && !keep[i]) continue;
    const v = norm[i];
    if (((i % 8) + (i >> 3)) & 1) { sb += v; qb += v * v; nb++; }
    else { sa += v; qa += v * v; na++; }
  }
  const mA = na ? sa / na : 0, mB = nb ? sb / nb : 0;
  const sdA = Math.sqrt(Math.max(0, qa / na - mA * mA));
  const sdB = Math.sqrt(Math.max(0, qb / nb - mB * mB));
  return { mA, mB, sdA, sdB, sep: Math.abs(mA - mB), na, nb };
}

/* ------------------------------------------------------------------ */
/* detection                                                           */
/* ------------------------------------------------------------------ */


/**
 * Cheap fit for a Hough candidate: the raw quad, a ridge snap and a fine snap.
 * Returns the best of the three by colour score.
 */
function refineCandidate(prepared, w, h, quad) {
  // A plain ridge snap is not always right: a row of pieces standing near the
  // board edge makes a stronger line just *inside* the frame than the edge
  // itself, and snapping onto it shears the grid by half a cell. So every
  // candidate is judged by what it scores, and the best of the fits wins.
  let best = null;
  const consider = (q) => {
    if (!q || !validQuad(q, w, h)) return;
    const sc = scoreQuad(prepared, w, h, q);
    if (sc && (!best || sc.score > best.sc.score)) best = { quad: q, sc };
  };

  consider(quad.map((p) => p.slice()));
  const snapped = snapQuad(prepared.mag, w, h, quad, 10);
  consider(snapped);
  if (snapped) consider(snapQuad(prepared.mag, w, h, snapped, 3));
  return best;
}

/**
 * Score-guided fit (scale + centre) for a candidate that already looks like a
 * board. This is what recovers the true edge when the ridges are weak — a
 * bordered board, uneven light, a row of pieces — but it costs ~20 samples, so
 * it is only ever run for one candidate per pyramid level, and only when that
 * candidate is plausible.
 */
function fitCandidate(prepared, w, h, quad) {
  const q = refineQuad(prepared, w, h, quad, { inset: true, passes: 3 });
  if (!q || !validQuad(q, w, h)) return null;
  const sc = scoreQuad(prepared, w, h, q);
  return sc ? { quad: q, sc } : null;
}

/** Score high enough that no other quad in the frame can plausibly beat it. */
const DECISIVE = 3.0;
/** The same for the trimmed score, which is the only one an occluded board has. */
const DECISIVE_TRIM = 4.3;
/** Strict score below this means "the board is hidden, not absent". */
const HIDDEN = 1.6;
/** Above this a candidate is worth the score-guided fit. */
const PLAUSIBLE = 1.1;

/**
 * Find the most chessboard-looking quad.
 *
 * Runs coarse-to-fine over the pyramid and stops at the first scale that
 * produces a decisive score, which is nearly always the 1/4-scale one: at that
 * size the inner grid has blurred away and only the board's rim is left, so it
 * costs one small Hough transform instead of a full-resolution search.
 *
 * The colour score is sharply peaked, so Hough candidates (a few pixels out,
 * and quantised coarser still at 1/4 scale) are always snapped onto their
 * ridges before being judged.
 *
 * A quad is accepted when the strict score clears 2.5, or — if part of the
 * board is covered by a hand or an arm — when the trimmed score clears 3.5,
 * which no quad that is merely *near* a board ever reaches. That is what lets
 * the board be found while somebody is leaning over it, without letting the
 * detector lock onto a table.
 *
 * @returns {{quad: number[][], score: number, sep: number, trimmed: number}|null}
 */
export function detectQuad(prepared, w, h) {
  const levels = [
    [prepared.mag4, prepared.sw4, prepared.sh4],
    [prepared.mag2, prepared.sw, prepared.sh],
    [prepared.mag, w, h],
  ];
  let best = null;
  const tried = [];

  const done = (r) => ({
    quad: r.quad, score: r.sc.score, sep: r.sc.sep, trimmed: r.sc.trim(),
  });

  for (const [mag, mw, mh] of levels) {
    const sx = w / mw, sy = h / mh;
    const list = quadsFromLines(mag, mw, mh, 40);
    const maxCands = best && best.sc.score > 0.8 ? 4 : 3;
    let used = 0;
    for (const c of list) {
      if (used >= maxCands) break;
      const quad = c.quad.map(([x, y]) => [x * sx, y * sy]);
      if (tried.some((t) => quadDist(t, quad) < w * 0.02)) continue;
      tried.push(quad);
      used++;
      const r = refineCandidate(prepared, w, h, quad);
      if (r && (!best || r.sc.score > best.sc.score)) best = r;
      if (best && best.sc.score >= DECISIVE) return done(best);
      // partially covered board: only now is the trimmed pass worth its cost
      if (best && best.sc.score > HIDDEN && best.sc.trim() >= DECISIVE_TRIM) return done(best);
    }
  }

  // The score-guided fit is what saves a bordered board, a hard light gradient
  // or a row of pieces along an edge. It costs ~20 samples, so it is run once,
  // on the single best candidate, and only if that candidate is board-ish.
  if (best && best.sc.score < DECISIVE && best.sc.score > PLAUSIBLE) {
    const fitted = fitCandidate(prepared, w, h, best.quad);
    if (fitted && fitted.sc.score > best.sc.score) best = fitted;
    if (best.sc.score >= DECISIVE) return done(best);
    if (best.sc.score > HIDDEN && best.sc.trim() >= DECISIVE_TRIM) return done(best);
  }

  if (!best) return null;
  const sc = best.sc;
  if (sc.sep < 0.18) return null;
  if (!(sc.score > 2.5 || sc.trim() > 3.5)) return null;
  return done(best);
}

/** Circular distance between two line directions (degrees, both mod 180). */
function angleDist(a, b) {
  let d = Math.abs(a - b) % 180;
  return d > 90 ? 180 - d : d;
}

/**
 * Find the two dominant directions in a line set.
 *
 * A chessboard is two families of roughly parallel lines about 90 degrees
 * apart, so one round of weighted voting finds the stronger family and the
 * second is simply perpendicular to it. Perspective makes the members of a
 * family converge by up to ~20 degrees, hence the wide kernel.
 */
function dominantDirections(lines) {
  let best = null;
  for (const l of lines) {
    let acc = 0;
    for (const o of lines) acc += Math.max(0, 1 - angleDist(l.theta, o.theta) / 26);
    if (!best || acc > best.acc) best = { theta: l.theta, acc };
  }
  const t1 = best ? best.theta : 0;
  let best2 = null;
  for (const l of lines) {
    if (angleDist(l.theta, t1) < 30) continue;
    let acc = 0;
    for (const o of lines) {
      if (angleDist(o.theta, t1) < 30) continue;
      acc += Math.max(0, 1 - angleDist(l.theta, o.theta) / 26);
    }
    if (!best2 || acc > best2.acc) best2 = { theta: l.theta, acc };
  }
  if (!best2) return [t1, t1 + 90];
  return [t1, best2.theta];
}

/**
 * Candidate quads in the coordinate space of `mag`, which may be a pyramid
 * level. Returns quads sorted by board-likeness, largest first.
 */
function quadsFromLines(mag, mw, mh, maxLines) {
  const lines = houghLines(mag, mw, mh, maxLines);
  if (lines.length < 4) return [];

  const [t1, t2] = dominantDirections(lines);
  const famA = [], famB = [];
  for (const l of lines) {
    const dA = angleDist(l.theta, t1), dB = angleDist(l.theta, t2);
    if (Math.min(dA, dB) > 26) continue;
    (dA <= dB ? famA : famB).push(l);
  }
  if (famA.length < 2 || famB.length < 2) return [];

  // A board side spans several cells, so opposite lines must be far apart.
  // Dropping near-coincident pairs removes most of the 40-choose-2 combinations
  // (the grid lines of a small board are only ~1 cell apart) before any work.
  const minSep = Math.min(mw, mh) * 0.22;
  const pairsOf = (fam) => {
    const out = [];
    for (let i = 0; i < fam.length; i++) {
      for (let j = i + 1; j < fam.length; j++) {
        if (Math.abs(fam[i].rho - fam[j].rho) < minSep) continue;
        out.push([i, j]);
      }
    }
    return out;
  };
  const pA = pairsOf(famA), pB = pairsOf(famB);
  if (!pA.length || !pB.length) return [];

  // every crossing point, computed once
  const X = famA.map((a) => famB.map((b) => intersectLines(a, b)));

  const cands = [];
  for (const [a, b] of pA) {
    for (const [c, d] of pB) {
      const p0 = X[a][c], p1 = X[a][d], p2 = X[b][d], p3 = X[b][c];
      if (!p0 || !p1 || !p2 || !p3) continue;
      const q = orderByAngle([p0, p1, p2, p3]);
      if (!validQuad(q, mw, mh)) continue;
      const rank = quadRank(q);
      if (!rank) continue;
      cands.push({ quad: q, area: rank });
    }
  }
  cands.sort((x, y) => y.area - x.area);
  return cands;
}

/**
 * Candidate quads from the detected lines, largest first.
 *
 * A chessboard is two families of near-parallel lines about 90 degrees apart,
 * so the lines are split those two families and every pair of one is crossed
 * with every pair of the other. Enumerating all 4-subsets cannot work: 24
 * choose 4 quads is far too many to snap and score, and it is the pairing that
 * carries the meaning anyway.
 */
export function candidateQuads(prepared, w, h) {
  const out = [];
  const seen = [];
  const push = (list, sx, sy) => {
    for (const c of list) {
      const quad = c.quad.map(([x, y]) => [x * sx, y * sy]);
      if (seen.some((s) => quadDist(s, quad) < w * 0.02)) continue;
      seen.push(quad);
      out.push({ quad, area: quadArea(quad) });
    }
  };
  // coarse first: at 1/4 scale the inner grid has averaged away and the rim is
  // the strongest structure in the image
  push(quadsFromLines(prepared.mag4, prepared.sw4, prepared.sh4, 40), w / prepared.sw4, h / prepared.sh4);
  push(quadsFromLines(prepared.mag2, prepared.sw, prepared.sh, 40), w / prepared.sw, h / prepared.sh);
  if (!out.length) push(quadsFromLines(prepared.mag, w, h, 40), 1, 1);
  out.sort((a, b) => b.area - a.area);
  return out;
}

/** Mean corner distance between two cyclic quads, ignoring where they start. */
function quadDist(a, b) {
  let best = Infinity;
  for (let k = 0; k < 4; k++) {
    let s = 0;
    for (let i = 0; i < 4; i++) {
      const p = a[i], q = b[(i + k) % 4];
      s += Math.hypot(p[0] - q[0], p[1] - q[1]);
    }
    best = Math.min(best, s / 4);
  }
  return best;
}

/**
 * Cheap shape prior for "could this be a chessboard seen in perspective?".
 *
 * Returns a ranking weight (bigger is better) or 0 for shapes no camera could
 * turn a square into: opposite sides must be comparable and the aspect ratio
 * must stay square-ish. This is deliberately loose; the colour score does the
 * real work.
 */
function quadRank(q) {
  const len = [0, 0, 0, 0];
  for (let i = 0; i < 4; i++) {
    len[i] = Math.hypot(q[(i + 1) % 4][0] - q[i][0], q[(i + 1) % 4][1] - q[i][1]);
  }
  const h1 = (len[0] + len[2]) / 2, h2 = (len[1] + len[3]) / 2;
  if (Math.min(h1, h2) < 8) return 0;
  // opposite sides should not differ wildly (perspective shortens a far side)
  if (Math.abs(len[0] - len[2]) / Math.max(len[0], len[2]) > 0.6) return 0;
  if (Math.abs(len[1] - len[3]) / Math.max(len[1], len[3]) > 0.6) return 0;
  const ar = h1 / h2;
  if (ar < 0.5 || ar > 2.0) return 0;
  return quadArea(q) * Math.min(1, 1.6 - Math.abs(Math.log(ar)));
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
  const nS = Math.floor((2 * half) / stepT) + 1;
  const SEG = 6;
  const segSum = new Float64Array(SEG), segN = new Uint8Array(SEG);

  const scoreAt = (c, s, off) => {
    const vx = ux * c - uy * s, vy = ux * s + uy * c;
    const nx = -vy, ny = vx;
    // Score six contiguous stretches of the side and average the middle four.
    // Dropping the weakest and strongest stretch is what keeps the snap on the
    // board edge when a hand hides part of it (weak) or a piece sits on it
    // (strong): a plain mean over the whole side is dragged off by either.
    segSum.fill(0); segN.fill(0);
    for (let k = 0; k < nS; k++) {
      const t = -half + k * stepT;
      const v = sampleBilinear(mag, w, h, mx + nx * off + vx * t, my + ny * off + vy * t);
      if (v === null) continue;
      const g = Math.min(SEG - 1, (k * SEG / nS) | 0);
      segSum[g] += Math.min(v, 700); segN[g]++;
    }
    let lo = Infinity, hi = -Infinity, sum = 0, n = 0;
    for (let g = 0; g < SEG; g++) {
      if (!segN[g]) continue;
      const m = segSum[g] / segN[g];
      sum += m; n++;
      if (m < lo) lo = m;
      if (m > hi) hi = m;
    }
    if (!n) return 0;
    if (n <= 3) return sum / n;
    return (sum - lo - hi) / (n - 2);
  };

  // coarse over angle and offset, then a fine pass at half-pixel resolution so
  // the grid does not jitter between frames
  let best = null;
  const dOff = range / 4;
  for (let ai = -3; ai <= 3; ai++) {
    const ang = ai * 0.02, c = Math.cos(ang), s = Math.sin(ang);
    for (let oi = -4; oi <= 4; oi++) {
      const off = oi * dOff;
      const sc = scoreAt(c, s, off);
      if (!best || sc > best.sc) best = { sc, ang, off };
    }
  }
  const fineO = range / 16;
  for (let ai = -2; ai <= 2; ai++) {
    const ang = best.ang + ai * 0.008, c = Math.cos(ang), s = Math.sin(ang);
    for (let oi = -2; oi <= 2; oi++) {
      const off = best.off + oi * fineO;
      const sc = scoreAt(c, s, off);
      if (sc > best.sc) best = { sc, ang, off };
    }
  }

  const c = Math.cos(best.ang), s = Math.sin(best.ang);
  const vx = ux * c - uy * s, vy = ux * s + uy * c;
  return { sc: best.sc, vx, vy, px: mx + -vy * best.off, py: my + vx * best.off };
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
export function refineQuad(prepared, w, h, quad, { inset = false, passes = 2, iters = 3, polish = true } = {}) {
  const { mag } = prepared;
  let best = quad.map((p) => p.slice());
  let bestScore = scoreQuad(prepared, w, h, best);
  if (!bestScore) return quad;

  if (inset) {
    // Fit the quad to the board by *score*, not by ridge strength: first the
    // scale about the centre, then the centre offset. (Searching the two axes
    // together costs 90 samples, the axes separately 19, and the two are almost
    // independent — the scale is what matters, the offset only fine-tunes.)
    const cx = (best[0][0] + best[1][0] + best[2][0] + best[3][0]) / 4;
    const cy = (best[0][1] + best[1][1] + best[2][1] + best[3][1]) / 4;
    const base = best.map((p) => p.slice());
    const size = (Math.hypot(base[1][0] - base[0][0], base[1][1] - base[0][1])
      + Math.hypot(base[2][0] - base[1][0], base[2][1] - base[1][1])) / 2;
    const tryIt = (cand) => {
      if (!validQuad(cand, w, h)) return;
      const sc = scoreQuad(prepared, w, h, cand);
      if (sc && sc.score > bestScore.score) { best = cand; bestScore = sc; }
    };
    for (const kk of [1, 0.98, 0.96, 0.94, 0.92, 0.9, 0.88, 0.86, 0.84, 1.02, 0.8, 0.78]) {
      tryIt(base.map(([x, y]) => [cx + (x - cx) * kk, cy + (y - cy) * kk]));
    }
    const scaled = best;
    for (const sx of [-0.02, 0, 0.02]) {
      for (const sy of [-0.02, 0, 0.02]) {
        if (!sx && !sy) continue;
        tryIt(scaled.map(([x, y]) => [x + size * sx, y + size * sy]));
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

  // small uphill walk on the colour score (skipped while merely tracking: the
  // snap already lands on the ridge, and this walk was most of the cost of a
  // per-frame refine)
  if (!polish) return best;
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

/** Pre-multiply a homography's output by (sx, sy), for sampling a smaller image. */
export function scaleHomography(H, sx, sy) {
  return [
    H[0] * sx, H[1] * sx, H[2] * sx,
    H[3] * sy, H[4] * sy, H[5] * sy,
    H[6], H[7], H[8],
  ];
}

/**
 * Square descriptor: 3x3 patch means per square, sampled at full resolution.
 *
 * Brightness alone is not enough — a white pawn on a light square barely moves
 * the mean of the square — so the 3x3 layout is kept and compared with an RMS
 * difference, which responds to the *structure* a piece adds.
 *
 * This is only stable because the tracker freezes the sampling grid while the
 * board is not moving; see BoardTracker.
 */
export function describeBoard(prepared, w, h, H) {
  return describeSquares(prepared.gray, w, h, H, 0.08);
}

/**
 * 64 squares x 3x3 samples, indexed rank-major (a1 = 0).
 *
 * `patch` is the half-width, in squares, of the little box averaged around each
 * sample; 0 means a single bilinear sample.
 */
export function describeSquares(gray, w, h, H, patch = 0) {
  const out = new Float32Array(64 * 9);
  const h0 = H[0], h1 = H[1], h2 = H[2];
  const h3 = H[3], h4 = H[4], h5 = H[5];
  const h6 = H[6], h7 = H[7], h8 = H[8];
  const steps = patch > 0 ? [-patch, 0, patch] : [0];
  const ns = steps.length;
  const xmax = w - 1, ymax = h - 1;

  for (let r = 0; r < 8; r++) {
    for (let f = 0; f < 8; f++) {
      // The four corners of this square, then a bilinear map inside it. Over a
      // single square the difference from the exact homography is well below a
      // pixel, and this keeps every sample free of a projection and an
      // allocation (which is what made this 20 ms before).
      const d00 = h6 * f + h7 * r + h8;
      const d10 = h6 * (f + 1) + h7 * r + h8;
      const d01 = h6 * f + h7 * (r + 1) + h8;
      const d11 = h6 * (f + 1) + h7 * (r + 1) + h8;
      if (!d00 || !d10 || !d01 || !d11) continue;
      const x00 = (h0 * f + h1 * r + h2) / d00, y00 = (h3 * f + h4 * r + h5) / d00;
      const x10 = (h0 * (f + 1) + h1 * r + h2) / d10, y10 = (h3 * (f + 1) + h4 * r + h5) / d10;
      const x01 = (h0 * f + h1 * (r + 1) + h2) / d01, y01 = (h3 * f + h4 * (r + 1) + h5) / d01;
      const x11 = (h0 * (f + 1) + h1 * (r + 1) + h2) / d11, y11 = (h3 * (f + 1) + h4 * (r + 1) + h5) / d11;
      const ax = x10 - x00, ay = y10 - y00;
      const bx = x01 - x00, by = y01 - y00;
      const cx = x11 - x10 - x01 + x00, cy = y11 - y10 - y01 + y00;

      const base = (r * 8 + f) * 9;
      for (let i = 0; i < 3; i++) {
        for (let j = 0; j < 3; j++) {
          let sum = 0, n = 0;
          for (let vi = 0; vi < ns; vi++) {
            const v = 0.25 + 0.25 * i + steps[vi];
            for (let ui = 0; ui < ns; ui++) {
              const u = 0.25 + 0.25 * j + steps[ui];
              const uv = u * v;
              const px = x00 + ax * u + bx * v + cx * uv;
              const py = y00 + ay * u + by * v + cy * uv;
              if (!(px >= 0 && py >= 0 && px <= xmax && py <= ymax)) continue;
              const x0 = px | 0, y0 = py | 0;
              const fx = px - x0, fy = py - y0;
              const x1 = x0 < xmax ? x0 + 1 : x0;
              const y1 = y0 < ymax ? y0 + 1 : y0;
              const r0 = y0 * w, r1 = y1 * w;
              const a0 = gray[r0 + x0], b0 = gray[r0 + x1];
              const c0 = gray[r1 + x0], d0 = gray[r1 + x1];
              const top = a0 + (b0 - a0) * fx;
              const bot = c0 + (d0 - c0) * fx;
              sum += top + (bot - top) * fy;
              n++;
            }
          }
          out[base + i * 3 + j] = n ? sum / n : 0;
        }
      }
    }
  }
  return out;
}

/**
 * Per-square difference between two descriptors (0..255).
 *
 * Two terms are combined: the RMS difference of the nine patch means (catches
 * brightness) and the RMS difference *after* removing each square's own mean
 * (catches shape). The second is what makes a white pawn on a light square
 * visible: overall brightness barely moves, but the 3x3 pattern does.
 */
export function squareDiff(a, b) {
  const out = new Float32Array(64);
  for (let s = 0; s < 64; s++) {
    const base = s * 9;
    let m1 = 0, m2 = 0;
    for (let k = 0; k < 9; k++) { m1 += a[base + k]; m2 += b[base + k]; }
    m1 /= 9; m2 /= 9;
    let flat = 0, shape = 0;
    for (let k = 0; k < 9; k++) {
      const d = a[base + k] - b[base + k];
      const s1 = (a[base + k] - m1) - (b[base + k] - m2);
      flat += d * d;
      shape += s1 * s1;
    }
    out[s] = Math.max(Math.sqrt(flat / 9), Math.sqrt(shape / 9) * 1.6);
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
  constructor({ side = 'w', detectEvery = 12 } = {}) {
    this.side = side;
    this.detectEvery = detectEvery;
    this.quad = null;
    this.H = null;
    this.score = 0;
    this.scoreTrim = 0;
    this.tick = 0;
    this.misses = 0;
    this.badFrames = 0;
    this.prevThumb = null;
    this.prevTw = 0;
    this.prevTh = 0;
    this.lastPrepared = null;
    this.still = false;
    this.motion = Infinity;
    this.redetected = false;
    this.vel = null;
    this.frames = 0;
    this.lastDetect = -999;
  }

  reset() {
    this.quad = null;
    this.H = null;
    this.score = 0;
    this.scoreTrim = 0;
    this.misses = 0;
    this.badFrames = 0;
    this.tick = 0;
    this.prevThumb = null;
    this.lastPrepared = null;
    this.vel = null;
  }

  get locked() {
    return !!this.quad;
  }

  /**
   * Where the board is expected to be on the next frame: the last quad plus the
   * smoothed corner velocity, capped at a fraction of the board size so one bad
   * frame cannot fling the prediction off the screen.
   */
  predict(quad = this.quad) {
    const v = this.vel;
    if (!quad || !v) return quad;
    let size = 0;
    for (let i = 0; i < 4; i++) size += Math.hypot(quad[(i + 1) % 4][0] - quad[i][0], quad[(i + 1) % 4][1] - quad[i][1]);
    const cap = size / 4 * 0.08;
    return quad.map(([x, y], i) => {
      const dx = Math.max(-cap, Math.min(cap, v[i][0]));
      const dy = Math.max(-cap, Math.min(cap, v[i][1]));
      return [x + dx, y + dy];
    });
  }

  /** Smoothed per-corner motion, used by predict(). */
  trackVelocity(prev, next) {
    if (!prev) return;
    const v = this.vel;
    if (!v) {
      this.vel = next.map(([x, y], i) => [x - prev[i][0], y - prev[i][1]]);
      return;
    }
    for (let i = 0; i < 4; i++) {
      const dx = next[i][0] - prev[i][0], dy = next[i][1] - prev[i][1];
      v[i][0] = v[i][0] * 0.55 + dx * 0.45;
      v[i][1] = v[i][1] * 0.55 + dy * 0.45;
    }
  }

  /**
   * @param {Uint8ClampedArray} rgba pixels at w x h
   * @returns {{quad:number[][]|null, H:number[]|null, score:number, redetected:boolean}}
   */
  update(rgba, w, h) {
    this.frames++;
    this.redetected = false;
    const quadBefore = this.quad;

    // Cheap gate first: a quarter-scale thumbnail of the camera frame, diffed
    // against the previous one. If the scene is static there is nothing to fit
    // and nothing to sample, so the whole vision path is skipped and the
    // previous descriptor is reused verbatim. This is the path a phone holding
    // still on a board takes, and it costs a fraction of a millisecond.
    const t = thumbFromRGBA(rgba, w, h, this.prevThumb, this.prevTw, this.prevTh);
    this.prevThumb = t.thumb;
    this.prevTw = t.tw;
    this.prevTh = t.th;
    const motion = t.motion;

    if (this.quad && motion < 1.2) {
      this.quadShift = 0;
      this.motion = motion;
      this.still = true;
      // nothing is moving, so nothing will be moving next frame either: a
      // stale velocity would throw the next prediction off
      this.vel = null;
      return {
        quad: this.quad, H: this.H, score: this.score, scoreTrim: this.scoreTrim,
        quadShift: 0, redetected: false, motion, prepared: this.lastPrepared, still: true,
      };
    }
    this.still = false;

    const prepared = prepareFrame(rgba, w, h);
    this.lastPrepared = prepared;
    const before = this.quad;

    // Is the board still there, even if part of it is covered? The trimmed
    // score answers that; the strict score only answers "is all of it visible".
    const stale = this.quad && this.score < 3 && this.scoreTrim < 2.6;
    const heartbeat = this.tick++ % this.detectEvery === 0;
    // While a hand or an arm covers the board a fresh search cannot succeed, so
    // it must not run on every frame: it costs tens of milliseconds and would
    // stall the overlay exactly while the game is being played.
    const due = !this.quad || heartbeat || (stale && this.tick - this.lastDetect >= 5);
    if (due) {
      this.lastDetect = this.tick;
      const det = detectQuad(prepared, w, h);
      if (det) {
        this.misses = 0;
        this.redetected = true;
        // If the detection lands on the board we already have, keep the
        // existing lock: re-seating the grid by a pixel for no reason is what
        // made every square look like it had changed.
        const close = this.quad && meanCornerShift(this.quad, det.quad) < w * 0.02;
        if (!close) {
          this.quad = refineQuad(prepared, w, h, det.quad, { inset: true, passes: 3 });
          // a re-seat is a jump, not motion: do not feed it to the predictor
          this.vel = null;
        }
        const sc = scoreQuad(prepared, w, h, this.quad);
        if (sc) { this.score = sc.score; this.scoreTrim = sc.trim(); }
      } else if (this.quad) {
        // A hand across the board hides the rim for a while; losing the lock on
        // the first few misses is what forces a full re-detection in the middle
        // of a game. If the trimmed score says the board is still there, this
        // miss means nothing at all and must not count.
        if (this.scoreTrim > 2.2) this.misses = 0;
        else if (++this.misses > 10) this.reset();
      }
    }

    if (this.quad) {
      // Follow the board on every moving frame, starting from where the last
      // frames say it is going. Predicting first is what keeps the grid glued
      // to the board during a pan instead of lagging a frame behind (and it
      // widens the distance the local snap can recover from, so the lock
      // survives a brisk camera move without a full re-detection).
      const start = this.predict(this.quad) || this.quad;
      const refined = refineQuad(prepared, w, h, start, { passes: 1, polish: false });
      const sc = refined && validQuad(refined, w, h) ? scoreQuad(prepared, w, h, refined) : null;
      const trimScore = sc ? sc.trim() : 0;
      if (sc && trimScore > 1.9) {
        // only follow the ridge when it actually moved: re-fitting a static
        // board is what makes the sampling grid wobble. On a healthy lock that
        // means a whole pixel; on a slipping one, half a pixel is worth taking.
        const shift = before ? meanCornerShift(before, refined) : Infinity;
        if (shift > (this.score > 4 ? 1.2 : 0.6)) {
          this.quad = refined;
          this.trackVelocity(before, refined);
        }
        this.score = sc.score;
        this.scoreTrim = trimScore;
        this.badFrames = 0;
      } else if (++this.badFrames > 24) {
        // the board is gone or the camera swung away: drop the lock so the
        // next frame does a fresh search
        this.reset();
      }
    }

    this.H = this.quad ? boardHomography(this.quad, this.side) : null;
    // how far the sampling grid moved this frame: callers must not compare
    // square descriptors across a grid change
    this.quadShift = quadBefore && this.quad ? meanCornerShift(quadBefore, this.quad) : 0;
    this.motion = motion;
    return {
      quad: this.quad, H: this.H, score: this.score, scoreTrim: this.scoreTrim,
      quadShift: this.quadShift, redetected: this.redetected, motion, prepared, still: false,
    };
  }
}

function meanCornerShift(a, b) {
  let s = 0;
  for (let i = 0; i < 4; i++) s += Math.hypot(a[i][0] - b[i][0], a[i][1] - b[i][1]);
  return s / 4;
}
