/*
 * Automatic region detection for striped test sheets.
 * Pure functions, no DOM. Browser: window.Detect. Node: require.
 *
 * detectPattern(): finds the striped area, returns its four corners. A point counts as "inside the pattern"
 *                  when its surroundings have enough contrast AND there are light and dark stripes on both
 *                  sides of it. A single edge (card border, shadow) is ignored.
 * rectify():       straightens that quadrilateral into an upright rectangle (perspective correction).
 */
(function (root) {
  'use strict';

  const DEFAULTS = {
    workWidth: 240, // detection runs on a downscaled copy about this wide
    win: 24,        // analysis window (work px); each half must span a full stripe + gap
    step: 4,        // window step (work px)
    seed: 0.18,     // contrast (std / mean) that certainly is stripe pattern
    grow: 0.06,     // weaker contrast accepted when connected to a seed (faint stripes)
    minAreaFrac: 0.03,
  };

  // ---------- homography: unit square (u, v) -> quad [TL, TR, BR, BL] ----------
  function squareToQuad(q) {
    const x0 = q[0].x, y0 = q[0].y, x1 = q[1].x, y1 = q[1].y, x2 = q[2].x, y2 = q[2].y, x3 = q[3].x, y3 = q[3].y;
    const dx1 = x1 - x2, dx2 = x3 - x2, sx = x0 - x1 + x2 - x3;
    const dy1 = y1 - y2, dy2 = y3 - y2, sy = y0 - y1 + y2 - y3;
    let g = 0, h = 0;
    const det = dx1 * dy2 - dy1 * dx2;
    if ((Math.abs(sx) > 1e-9 || Math.abs(sy) > 1e-9) && Math.abs(det) > 1e-12) {
      g = (sx * dy2 - dx2 * sy) / det;
      h = (dx1 * sy - sx * dy1) / det;
    }
    const m = [x1 - x0 + g * x1, x3 - x0 + h * x3, x0, y1 - y0 + g * y1, y3 - y0 + h * y3, y0, g, h, 1];
    const map = (u, v) => {
      const d = m[6] * u + m[7] * v + 1;
      return [(m[0] * u + m[1] * v + m[2]) / d, (m[3] * u + m[4] * v + m[5]) / d];
    };
    map.matrix = m;
    return map;
  }

  // inverse mapping: quad point (x, y) -> (u, v)
  function quadToSquare(q) {
    const m = squareToQuad(q).matrix;
    const a = m[0], b = m[1], c = m[2], d = m[3], e = m[4], f = m[5], g = m[6], h = m[7], i = m[8];
    const A = e * i - f * h, B = c * h - b * i, Cc = b * f - c * e;
    const D = f * g - d * i, E = a * i - c * g, F = c * d - a * f;
    const G = d * h - e * g, H = b * g - a * h, I = a * e - b * d;
    return (x, y) => {
      const w = G * x + H * y + I;
      return [(A * x + B * y + Cc) / w, (D * x + E * y + F) / w];
    };
  }

  // ---------- helpers ----------
  function convexHull(pts) {
    const p = pts.slice().sort((a, b) => a.x - b.x || a.y - b.y);
    if (p.length < 3) return p;
    const cross = (o, a, b) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
    const lower = [];
    for (const pt of p) { while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], pt) <= 0) lower.pop(); lower.push(pt); }
    const upper = [];
    for (let k = p.length - 1; k >= 0; k--) { const pt = p[k]; while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], pt) <= 0) upper.pop(); upper.push(pt); }
    lower.pop(); upper.pop();
    return lower.concat(upper);
  }

  const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

  // Best 4-connected component of cells where mask[i] is truthy: the one with most seed cells
  // (or simply the largest when no seedMask is given). Returns Uint8Array (1 = in component) and size.
  function largestComponent(mask, gw, gh, seedMask) {
    const label = new Int32Array(gw * gh);
    let best = 0, bestSize = 0, cur = 0;
    const stack = [];
    for (let i = 0; i < gw * gh; i++) {
      if (!mask[i] || label[i] || (seedMask && !seedMask[i])) continue;
      cur++; let size = 0;
      stack.push(i); label[i] = cur;
      while (stack.length) {
        const k = stack.pop(); size += seedMask ? seedMask[k] : 1;
        const x = k % gw, y = (k - x) / gw;
        if (x > 0 && mask[k - 1] && !label[k - 1]) { label[k - 1] = cur; stack.push(k - 1); }
        if (x < gw - 1 && mask[k + 1] && !label[k + 1]) { label[k + 1] = cur; stack.push(k + 1); }
        if (y > 0 && mask[k - gw] && !label[k - gw]) { label[k - gw] = cur; stack.push(k - gw); }
        if (y < gh - 1 && mask[k + gw] && !label[k + gw]) { label[k + gw] = cur; stack.push(k + gw); }
      }
      if (size > bestSize) { bestSize = size; best = cur; }
    }
    const out = new Uint8Array(gw * gh);
    if (best) for (let i = 0; i < gw * gh; i++) if (label[i] === best) out[i] = 1;
    return { mask: out, size: bestSize };
  }

  /**
   * Find the striped pattern in RGBA pixel data.
   * Returns { found, corners: [TL, TR, BR, BL] (image px), areaFrac, sideRatio, aspect, angleDeg, touchesBorder }.
   * corners are ordered so that the long side of the pattern is horizontal in the rectified image.
   */
  function detectPattern(data, width, height, options) {
    const o = Object.assign({}, DEFAULTS, options || {});
    const s = Math.max(1, Math.ceil(width / o.workWidth));
    const ww = Math.floor(width / s), wh = Math.floor(height / s);
    if (ww < o.win * 4 || wh < o.win * 4) return { found: false, reason: 'image too small' };

    // 1. Downscaled luma (box average) + integral images
    const W1 = ww + 1;
    const luma = new Float32Array(ww * wh);
    const I1 = new Float64Array(W1 * (wh + 1)), I2 = new Float64Array(W1 * (wh + 1));
    const inv = 1 / (s * s);
    for (let y = 0; y < wh; y++) {
      let row1 = 0, row2 = 0;
      for (let x = 0; x < ww; x++) {
        let sum = 0;
        for (let dy = 0; dy < s; dy++) {
          let i = ((y * s + dy) * width + x * s) * 4;
          for (let dx = 0; dx < s; dx++, i += 4) sum += 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
        }
        const l = sum * inv;
        luma[y * ww + x] = l;
        row1 += l; row2 += l * l;
        const k = (y + 1) * W1 + x + 1;
        I1[k] = I1[k - W1] + row1; I2[k] = I2[k - W1] + row2;
      }
    }

    // 2. Contrast grid
    const gw = Math.floor((ww - o.win) / o.step) + 1, gh = Math.floor((wh - o.win) / o.step) + 1;
    const seed = new Uint8Array(gw * gh), grow = new Uint8Array(gw * gh);
    const n = o.win * o.win;
    for (let gy = 0; gy < gh; gy++) {
      for (let gx = 0; gx < gw; gx++) {
        const x0 = gx * o.step, y0 = gy * o.step, x1 = x0 + o.win, y1 = y0 + o.win;
        const a = y0 * W1 + x0, b = y0 * W1 + x1, c = y1 * W1 + x0, d = y1 * W1 + x1;
        const mean = (I1[d] - I1[b] - I1[c] + I1[a]) / n;
        const varr = Math.max(0, (I2[d] - I2[b] - I2[c] + I2[a]) / n - mean * mean);
        const sd = Math.sqrt(varr), contrast = sd / (mean + 16);
        if (contrast < o.grow) continue;
        // The window centre is inside the pattern if, along its centre row or centre column, light and
        // dark alternate at least twice on EACH side of the centre (dark-light-dark or light-dark-light).
        // A single edge (card border, shadow, table next to the white margin) alternates once only.
        const hi = mean + 0.5 * sd, lo = mean - 0.5 * sd, hw = o.win >> 1;
        let inside = false;
        for (let dir = 0; dir < 2 && !inside; dir++) {
          let ok = true;
          for (let half = 0; half < 2 && ok; half++) {
            let state = 0, changes = 0;
            for (let k = half * hw; k < half * hw + hw; k++) {
              const l = dir === 0 ? luma[(y0 + hw) * ww + x0 + k] : luma[(y0 + k) * ww + x0 + hw];
              const st = l > hi ? 1 : l < lo ? -1 : 0;
              if (st !== 0 && st !== state) { if (state !== 0) changes++; state = st; }
            }
            ok = changes >= 2;
          }
          inside = ok;
        }
        if (!inside) continue;
        grow[gy * gw + gx] = 1;
        if (contrast >= o.seed) seed[gy * gw + gx] = 1;
      }
    }

    // 3. Largest component that contains certain stripes, then remove thin leaks (opening)
    let comp = largestComponent(grow, gw, gh, seed);
    if (!comp.size) return { found: false, reason: 'no pattern' };
    const er = new Uint8Array(gw * gh);
    for (let y = 1; y < gh - 1; y++) for (let x = 1; x < gw - 1; x++) {
      const k = y * gw + x;
      if (comp.mask[k] && comp.mask[k - 1] && comp.mask[k + 1] && comp.mask[k - gw] && comp.mask[k + gw]) er[k] = 1;
    }
    const core = largestComponent(er, gw, gh, null);
    if (core.size) {
      const di = new Uint8Array(gw * gh);
      for (let y = 0; y < gh; y++) for (let x = 0; x < gw; x++) {
        const k = y * gw + x;
        if (!comp.mask[k]) continue;
        if (core.mask[k] || (x > 0 && core.mask[k - 1]) || (x < gw - 1 && core.mask[k + 1]) || (y > 0 && core.mask[k - gw]) || (y < gh - 1 && core.mask[k + gw])) di[k] = 1;
      }
      comp = { mask: di, size: di.reduce((t, v) => t + v, 0) };
    }

    // 4. Boundary points -> hull
    const pts = [], boundary = [];
    let touchesBorder = false;
    const half = o.step / 2;
    for (let y = 0; y < gh; y++) for (let x = 0; x < gw; x++) {
      const k = y * gw + x;
      if (!comp.mask[k]) continue;
      const edge = x === 0 || y === 0 || x === gw - 1 || y === gh - 1;
      if (edge) touchesBorder = true;
      if (edge || !comp.mask[k - 1] || !comp.mask[k + 1] || !comp.mask[k - gw] || !comp.mask[k + gw]) {
        const cx = x * o.step + o.win / 2, cy = y * o.step + o.win / 2;
        boundary.push({ x: cx, y: cy });
        pts.push({ x: cx - half, y: cy - half }, { x: cx + half, y: cy - half }, { x: cx + half, y: cy + half }, { x: cx - half, y: cy + half });
      }
    }
    const hull = convexHull(pts);
    if (hull.length < 4) return { found: false, reason: 'no pattern' };

    // 5. Orientation = minimum-area bounding rectangle over hull edges
    let bestArea = Infinity, theta = 0;
    for (let i = 0; i < hull.length; i++) {
      const p = hull[i], q = hull[(i + 1) % hull.length];
      const a = Math.atan2(q.y - p.y, q.x - p.x), c = Math.cos(a), sn = Math.sin(a);
      let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity;
      for (const h of hull) {
        const u = h.x * c + h.y * sn, v = -h.x * sn + h.y * c;
        if (u < minU) minU = u; if (u > maxU) maxU = u; if (v < minV) minV = v; if (v > maxV) maxV = v;
      }
      const area = (maxU - minU) * (maxV - minV);
      if (area < bestArea) { bestArea = area; theta = a; }
    }
    let deg = (theta * 180) / Math.PI;
    while (deg > 45) deg -= 90;
    while (deg <= -45) deg += 90;
    theta = (deg * Math.PI) / 180;

    // 6. Corners = extremes of u+v / u-v in the rotated frame
    const c = Math.cos(theta), sn = Math.sin(theta);
    let tl = null, tr = null, br = null, bl = null, mnS = Infinity, mxS = -Infinity, mnD = Infinity, mxD = -Infinity;
    for (const h of hull) {
      const u = h.x * c + h.y * sn, v = -h.x * sn + h.y * c;
      if (u + v < mnS) { mnS = u + v; tl = h; }
      if (u + v > mxS) { mxS = u + v; br = h; }
      if (u - v > mxD) { mxD = u - v; tr = h; }
      if (u - v < mnD) { mnD = u - v; bl = h; }
    }
    // 6b. Refine: fit a straight line to the boundary points along each side (middle 70%, so ragged
    //     corners do not matter), push it out to cover them, and intersect neighbouring lines.
    let quad = [tl, tr, br, bl];
    const lines = [];
    for (let i = 0; i < 4; i++) {
      const A = quad[i], B = quad[(i + 1) % 4];
      const len = dist(A, B), dx = (B.x - A.x) / len, dy = (B.y - A.y) / len;
      const sel = [];
      for (const p of boundary) {
        const t = ((p.x - A.x) * dx + (p.y - A.y) * dy) / len;
        const d = (p.x - A.x) * dy - (p.y - A.y) * dx; // > 0 = outside (corners run clockwise on screen)
        if (t > 0.15 && t < 0.85 && Math.abs(d) < Math.max(3 * o.step, 0.15 * len)) sel.push({ t: t * len, d });
      }
      if (sel.length < 4) { lines.push(null); continue; }
      let mt = 0, md = 0; for (const q of sel) { mt += q.t; md += q.d; } mt /= sel.length; md /= sel.length;
      let stt = 0, std = 0; for (const q of sel) { stt += (q.t - mt) * (q.t - mt); std += (q.t - mt) * (q.d - md); }
      const slope = stt > 0 ? std / stt : 0;
      const res = sel.map((q) => q.d - (md + slope * (q.t - mt))).sort((a, b) => a - b);
      const off = md + res[Math.floor(res.length * 0.75)] + o.step / 2; // cover the outer boundary cells
      // line through P0 = A + off * n, direction rotated by slope; n = (dy, -dx)
      const P = { x: A.x + mt * dx + off * dy, y: A.y + mt * dy - off * dx };
      const dir = { x: dx + slope * dy, y: dy - slope * dx };
      lines.push({ P, dir });
    }
    if (lines.every((l) => l)) {
      const isect = (l1, l2) => {
        const den = l1.dir.x * l2.dir.y - l1.dir.y * l2.dir.x;
        if (Math.abs(den) < 1e-6) return null;
        const k = ((l2.P.x - l1.P.x) * l2.dir.y - (l2.P.y - l1.P.y) * l2.dir.x) / den;
        return { x: l1.P.x + k * l1.dir.x, y: l1.P.y + k * l1.dir.y };
      };
      const refined = [isect(lines[3], lines[0]), isect(lines[0], lines[1]), isect(lines[1], lines[2]), isect(lines[2], lines[3])];
      if (refined.every((p, i) => p && dist(p, quad[i]) < 0.25 * dist(quad[0], quad[2]))) quad = refined;
    }
    let corners = quad.map((p) => ({ x: p.x * s, y: p.y * s }));

    // 7. Metrics
    let top = dist(corners[0], corners[1]), right = dist(corners[1], corners[2]), bottom = dist(corners[2], corners[3]), left = dist(corners[3], corners[0]);
    if (Math.min(top, right, bottom, left) < 4 * s) return { found: false, reason: 'no pattern' };
    if (top + bottom < left + right) { // pattern is upright in the frame: make its long side the width
      corners = [corners[3], corners[0], corners[1], corners[2]];
      [top, right, bottom, left] = [left, top, right, bottom];
    }
    const quadArea = 0.5 * Math.abs(
      (corners[2].x - corners[0].x) * (corners[3].y - corners[1].y) - (corners[3].x - corners[1].x) * (corners[2].y - corners[0].y));
    const areaFrac = quadArea / (width * height);
    if (areaFrac < o.minAreaFrac) return { found: false, reason: 'pattern too small' };
    // The window needs room around the pattern: a corner this close to the frame edge may be cut off
    const pad = (o.win / 2 + o.step) * s;
    if (corners.some((p) => p.x < pad || p.y < pad || p.x > width - pad || p.y > height - pad)) touchesBorder = true;
    const sideRatio = Math.max(top / bottom, bottom / top, left / right, right / left);
    const aspect = (top + bottom) / (left + right);
    return { found: true, corners, areaFrac, sideRatio, aspect, angleDeg: deg, touchesBorder };
  }

  /**
   * Straighten the quad [TL, TR, BR, BL] into an upright rectangle (bilinear sampling).
   * Returns { data, width, height, map } where map(u, v) gives the source pixel for a point of the rectangle (0..1).
   */
  function rectify(data, width, height, corners, maxDim) {
    const wq = (dist(corners[0], corners[1]) + dist(corners[2], corners[3])) / 2;
    const hq = (dist(corners[1], corners[2]) + dist(corners[3], corners[0])) / 2;
    const k = Math.min(1, (maxDim || 900) / Math.max(wq, hq));
    const W = Math.max(8, Math.round(wq * k)), H = Math.max(8, Math.round(hq * k));
    const map = squareToQuad(corners);
    const out = new Uint8ClampedArray(W * H * 4);
    for (let j = 0; j < H; j++) {
      for (let i = 0; i < W; i++) {
        const p = map((i + 0.5) / W, (j + 0.5) / H);
        let x = Math.min(width - 1.001, Math.max(0, p[0] - 0.5)), y = Math.min(height - 1.001, Math.max(0, p[1] - 0.5));
        const x0 = Math.floor(x), y0 = Math.floor(y), fx = x - x0, fy = y - y0;
        const a = (y0 * width + x0) * 4, b = a + 4, c2 = a + width * 4, d = c2 + 4, o = (j * W + i) * 4;
        for (let ch = 0; ch < 3; ch++) {
          out[o + ch] = (data[a + ch] * (1 - fx) + data[b + ch] * fx) * (1 - fy) + (data[c2 + ch] * (1 - fx) + data[d + ch] * fx) * fy;
        }
        out[o + 3] = 255;
      }
    }
    return { data: out, width: W, height: H, map };
  }

  // ---------------------------------------------------------------------------------------------
  // Indicator fields: three pale coloured triangles (blue ... pink) arranged as a small pyramid
  // ---------------------------------------------------------------------------------------------
  const Col = typeof module !== 'undefined' && module.exports ? require('./colour.js') : root.Colour;
  const PATCH_DETECT = {
    workWidth: 360,
    hueMin: 240, hueMax: 30,   // candidate colours: blue through violet to pink
    cMin: 7, cMax: 45,         // pale colours only: vivid print (logos) is ignored
    lMin: 40, lMax: 95,
    minArea: 30,               // work px
  };

  /**
   * Find three similar coloured fields at roughly equal distances from each other.
   * Returns { found, fields: [{ x, y, side }] (image px; side = approximate width of a field),
   *           touchesBorder, multiple } - fields sorted top to bottom, left to right.
   */
  function detectPatches(data, width, height, options) {
    const o = Object.assign({}, PATCH_DETECT, options || {});
    const s = Math.max(1, Math.ceil(width / o.workWidth));
    const ww = Math.floor(width / s), wh = Math.floor(height / s), n = ww * wh;
    if (ww < 40 || wh < 40) return { found: false, reason: 'image too small' };
    // 1. downscale (box average, linear light)
    const R = new Float32Array(n), G = new Float32Array(n), B = new Float32Array(n), Y = new Float32Array(n);
    const inv = 1 / (s * s);
    for (let y = 0; y < wh; y++) for (let x = 0; x < ww; x++) {
      let r = 0, g = 0, b = 0;
      for (let dy = 0; dy < s; dy++) {
        let i = ((y * s + dy) * width + x * s) * 4;
        for (let dx = 0; dx < s; dx++, i += 4) { r += Col.srgbToLinear(data[i]); g += Col.srgbToLinear(data[i + 1]); b += Col.srgbToLinear(data[i + 2]); }
      }
      const k = y * ww + x;
      R[k] = r * inv; G[k] = g * inv; B[k] = b * inv;
      Y[k] = 0.2126729 * R[k] + 0.7151522 * G[k] + 0.072175 * B[k];
    }
    // 2. white = brightest 5% (the label paper)
    const cut = Float32Array.from(Y).sort()[Math.floor(n * 0.95)];
    let wr = 0, wg = 0, wb = 0, wn = 0;
    for (let k = 0; k < n; k++) if (Y[k] >= cut) { wr += R[k]; wg += G[k]; wb += B[k]; wn++; }
    if (!wn || wr / wn < 0.02) return { found: false, reason: 'too dark' };
    const white = [wr / wn, wg / wn, wb / wn];
    // 3. candidate mask
    const mask = new Uint8Array(n);
    for (let k = 0; k < n; k++) {
      if (Y[k] > cut * 0.97 || Y[k] < cut * 0.1) continue; // paper itself / very dark
      const lch = Col.labToLch(Col.linRgbToLab([R[k] * 0.85 / white[0], G[k] * 0.85 / white[1], B[k] * 0.85 / white[2]]));
      if (lch.C >= o.cMin && lch.C <= o.cMax && lch.L >= o.lMin && lch.L <= o.lMax && Col.hueIn(lch.h, o.hueMin, o.hueMax)) mask[k] = 1;
    }
    // 4. connected components (8-neighbour)
    const label = new Int32Array(n), blobs = [], stack = [];
    for (let i = 0; i < n; i++) {
      if (!mask[i] || label[i]) continue;
      const id = blobs.length + 1;
      let area = 0, sx = 0, sy = 0, x0 = ww, y0 = wh, x1 = 0, y1 = 0;
      stack.push(i); label[i] = id;
      while (stack.length) {
        const k = stack.pop(), x = k % ww, y = (k - x) / ww;
        area++; sx += x; sy += y;
        if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx, ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= ww || ny >= wh) continue;
          const q = ny * ww + nx;
          if (mask[q] && !label[q]) { label[q] = id; stack.push(q); }
        }
      }
      const bw = x1 - x0 + 1, bh = y1 - y0 + 1, fill = area / (bw * bh);
      if (area < o.minArea || bw > ww * 0.25 || bh > wh * 0.3) { blobs.push(null); continue; }
      if (bw / bh < 0.5 || bw / bh > 2 || fill < 0.3 || fill > 0.92) { blobs.push(null); continue; }
      blobs.push({ x: sx / area, y: sy / area, area, side: Math.sqrt(2 * area), edge: x0 <= 1 || y0 <= 1 || x1 >= ww - 2 || y1 >= wh - 2 });
    }
    const cand = blobs.filter((b) => b).sort((a, b) => b.area - a.area).slice(0, 24);
    // 5. best triple: similar size, roughly equal distances, close together
    const triples = [];
    for (let i = 0; i < cand.length; i++) for (let j = i + 1; j < cand.length; j++) for (let k = j + 1; k < cand.length; k++) {
      const t = [cand[i], cand[j], cand[k]];
      const areas = t.map((b) => b.area), ar = Math.max.apply(null, areas) / Math.min.apply(null, areas);
      if (ar > 2.5) continue;
      const d = [dist(t[0], t[1]), dist(t[0], t[2]), dist(t[1], t[2])];
      const dr = Math.max.apply(null, d) / Math.min.apply(null, d);
      if (dr > 1.7) continue;
      const side = (t[0].side + t[1].side + t[2].side) / 3, rel = (d[0] + d[1] + d[2]) / 3 / side;
      if (rel < 0.85 || rel > 2.6) continue;
      triples.push({ t, score: dr - 1 + 0.5 * (ar - 1) });
    }
    if (!triples.length) return { found: false, reason: 'no fields' };
    triples.sort((a, b) => a.score - b.score);
    const best = triples[0];
    const multiple = triples.some((x) => x.t.every((b) => best.t.indexOf(b) === -1));
    const fields = best.t.slice().sort((a, b) => (Math.abs(a.y - b.y) > best.t[0].side * 0.4 ? a.y - b.y : a.x - b.x))
      .map((b) => ({ x: (b.x + 0.5) * s, y: (b.y + 0.5) * s, side: b.side * s }));
    return { found: true, fields, touchesBorder: best.t.some((b) => b.edge), multiple };
  }

  const api = { detectPattern, detectPatches, rectify, squareToQuad, quadToSquare, convexHull, DEFAULTS };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Detect = api;
})(typeof window !== 'undefined' ? window : this);
