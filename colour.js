/*
 * Colour maths for the indicator colour test.
 * Pure functions, no DOM. Works in the browser (window.Colour) and in Node (require).
 *
 * Pipeline: sRGB pixels -> linear RGB average -> optional white-reference correction
 *           -> CIE XYZ (D65) -> CIELAB -> LCh -> classification (+ CIEDE2000 to calibration refs).
 */
(function (root) {
  'use strict';

  // ---------- sRGB <-> linear ----------
  function srgbToLinear(v255) {
    const c = v255 / 255;
    return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  }
  function linearToSrgb(lin) {
    const c = Math.min(1, Math.max(0, lin));
    const v = c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
    return v * 255;
  }

  // Lookup table: 8-bit sRGB -> linear (speeds up ROI averaging)
  const LIN = new Float64Array(256);
  for (let i = 0; i < 256; i++) LIN[i] = srgbToLinear(i);

  // ---------- linear RGB -> XYZ -> Lab (D65) ----------
  const WHITE_D65 = [0.95047, 1.0, 1.08883];

  function linRgbToXyz(r, g, b) {
    return [
      0.4124564 * r + 0.3575761 * g + 0.1804375 * b,
      0.2126729 * r + 0.7151522 * g + 0.072175 * b,
      0.0193339 * r + 0.119192 * g + 0.9503041 * b,
    ];
  }

  function xyzToLab(x, y, z) {
    const f = (t) => (t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 * t + 16) / 116);
    const fx = f(x / WHITE_D65[0]);
    const fy = f(y / WHITE_D65[1]);
    const fz = f(z / WHITE_D65[2]);
    return { L: 116 * fy - 16, a: 500 * (fx - fy), b: 200 * (fy - fz) };
  }

  function linRgbToLab(lin) {
    const xyz = linRgbToXyz(lin[0], lin[1], lin[2]);
    return xyzToLab(xyz[0], xyz[1], xyz[2]);
  }

  function srgbToLab(r, g, b) {
    return linRgbToLab([srgbToLinear(r), srgbToLinear(g), srgbToLinear(b)]);
  }

  function labToLch(lab) {
    const C = Math.hypot(lab.a, lab.b);
    let h = (Math.atan2(lab.b, lab.a) * 180) / Math.PI;
    if (h < 0) h += 360;
    return { L: lab.L, C: C, h: h };
  }

  // ---------- CIEDE2000 ----------
  function deltaE2000(l1, l2) {
    const rad = Math.PI / 180;
    const deg = 180 / Math.PI;
    const C1 = Math.hypot(l1.a, l1.b);
    const C2 = Math.hypot(l2.a, l2.b);
    const Cbar = (C1 + C2) / 2;
    const Cbar7 = Math.pow(Cbar, 7);
    const G = 0.5 * (1 - Math.sqrt(Cbar7 / (Cbar7 + Math.pow(25, 7))));
    const a1p = (1 + G) * l1.a;
    const a2p = (1 + G) * l2.a;
    const C1p = Math.hypot(a1p, l1.b);
    const C2p = Math.hypot(a2p, l2.b);
    const hp = (b, ap) => {
      if (b === 0 && ap === 0) return 0;
      const h = Math.atan2(b, ap) * deg;
      return h < 0 ? h + 360 : h;
    };
    const h1p = hp(l1.b, a1p);
    const h2p = hp(l2.b, a2p);

    const dLp = l2.L - l1.L;
    const dCp = C2p - C1p;
    let dhp = 0;
    if (C1p * C2p !== 0) {
      dhp = h2p - h1p;
      if (dhp > 180) dhp -= 360;
      else if (dhp < -180) dhp += 360;
    }
    const dHp = 2 * Math.sqrt(C1p * C2p) * Math.sin((dhp / 2) * rad);

    const Lbarp = (l1.L + l2.L) / 2;
    const Cbarp = (C1p + C2p) / 2;
    let hbarp = h1p + h2p;
    if (C1p * C2p !== 0) {
      if (Math.abs(h1p - h2p) > 180) hbarp = h1p + h2p < 360 ? (h1p + h2p + 360) / 2 : (h1p + h2p - 360) / 2;
      else hbarp = (h1p + h2p) / 2;
    }
    const T =
      1 -
      0.17 * Math.cos((hbarp - 30) * rad) +
      0.24 * Math.cos(2 * hbarp * rad) +
      0.32 * Math.cos((3 * hbarp + 6) * rad) -
      0.2 * Math.cos((4 * hbarp - 63) * rad);
    const dTheta = 30 * Math.exp(-Math.pow((hbarp - 275) / 25, 2));
    const Cbarp7 = Math.pow(Cbarp, 7);
    const Rc = 2 * Math.sqrt(Cbarp7 / (Cbarp7 + Math.pow(25, 7)));
    const Sl = 1 + (0.015 * Math.pow(Lbarp - 50, 2)) / Math.sqrt(20 + Math.pow(Lbarp - 50, 2));
    const Sc = 1 + 0.045 * Cbarp;
    const Sh = 1 + 0.015 * Cbarp * T;
    const Rt = -Math.sin(2 * dTheta * rad) * Rc;
    return Math.sqrt(
      Math.pow(dLp / Sl, 2) + Math.pow(dCp / Sc, 2) + Math.pow(dHp / Sh, 2) + Rt * (dCp / Sc) * (dHp / Sh)
    );
  }

  // ---------- Region statistics ----------
  /**
   * Average a square region of RGBA pixel data in LINEAR light.
   * data: Uint8ClampedArray (RGBA), width/height of the image, cx/cy centre, size = side in px.
   * Clipped pixels (any channel >= 250) are excluded from the mean and counted.
   */
  function regionStats(data, width, height, cx, cy, size) {
    const half = Math.max(1, Math.floor(size / 2));
    const x0 = Math.max(0, Math.round(cx) - half);
    const y0 = Math.max(0, Math.round(cy) - half);
    const x1 = Math.min(width, Math.round(cx) + half);
    const y1 = Math.min(height, Math.round(cy) + half);
    let n = 0;
    let clipped = 0;
    let sr = 0, sg = 0, sb = 0;
    const Ls = [];
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const i = (y * width + x) * 4;
        const r = data[i], g = data[i + 1], b = data[i + 2];
        if (r >= 250 || g >= 250 || b >= 250) { clipped++; continue; }
        const lr = LIN[r], lg = LIN[g], lb = LIN[b];
        sr += lr; sg += lg; sb += lb; n++;
        // luminance -> L* for the uniformity check
        const Y = 0.2126729 * lr + 0.7151522 * lg + 0.072175 * lb;
        Ls.push(Y > 216 / 24389 ? 116 * Math.cbrt(Y) - 16 : (24389 / 27) * Y);
      }
    }
    const total = n + clipped;
    if (n === 0) {
      return { n: 0, total: total, clippedFrac: total ? 1 : 0, lin: null, srgb: null, spreadL: null, box: [x0, y0, x1, y1] };
    }
    const lin = [sr / n, sg / n, sb / n];
    const meanL = Ls.reduce((s, v) => s + v, 0) / n;
    const spreadL = Math.sqrt(Ls.reduce((s, v) => s + (v - meanL) * (v - meanL), 0) / n);
    return {
      n: n,
      total: total,
      clippedFrac: clipped / total,
      lin: lin,
      srgb: lin.map(linearToSrgb),
      spreadL: spreadL,
      box: [x0, y0, x1, y1],
    };
  }

  /**
   * White-reference correction (von Kries in linear RGB).
   * Scales each channel so the white reference becomes neutral at a fixed level (target),
   * which corrects both colour cast and exposure between shots.
   */
  function applyWhiteReference(linSample, linWhite, target) {
    const t = target || 0.85;
    return [0, 1, 2].map((i) => (linWhite[i] > 1e-4 ? (linSample[i] * t) / linWhite[i] : linSample[i]));
  }

  // ---------- Classification ----------
  const DEFAULT_THRESHOLDS = {
    minChroma: 15,       // below this the colour is too grey to call
    minL: 15,            // too dark
    maxL: 92,            // too bright / washed out
    purpleHueMin: 270,   // LCh hue band accepted as purple (degrees)
    purpleHueMax: 340,
    growthHueMin: 40,    // LCh hue band treated as colour change (orange-yellow-green)
    growthHueMax: 200,
    maxSpreadL: 12,      // std-dev of L* inside the region; higher = edge/glare/label in region
    maxClippedFrac: 0.2, // share of saturated pixels allowed in the region
    maxDePurple: 20,     // calibrated: max ΔE2000 to the purple reference to accept purple
    marginDe: 10,        // calibrated: purple must be this much closer to purple than to yellow
    maxDeYellow: 30,     // calibrated: used only for colours outside both hue bands
  };

  function hueIn(h, min, max) {
    return min <= max ? h >= min && h <= max : h >= min || h <= max;
  }

  /**
   * Classify a region.
   * lab: measured Lab (corrected if a white reference was used).
   * stats: { spreadL, clippedFrac } from regionStats.
   * refs: { purple: Lab|null, yellow: Lab|null } calibration means (same correction mode), or null.
   * Returns { cls: 'no_growth'|'growth'|'uncertain', reasons: [], dePurple, deYellow, lch }.
   *
   * Safety rule: 'no_growth' needs every check to pass. Any doubt -> 'uncertain'.
   * A colour change is never upgraded to 'no_growth'.
   */
  function classify(lab, stats, refs, thresholds) {
    const t = Object.assign({}, DEFAULT_THRESHOLDS, thresholds || {});
    const lch = labToLch(lab);
    const reasons = [];
    const dePurple = refs && refs.purple ? deltaE2000(lab, refs.purple) : null;
    const deYellow = refs && refs.yellow ? deltaE2000(lab, refs.yellow) : null;
    const out = (cls) => ({ cls: cls, reasons: reasons, dePurple: dePurple, deYellow: deYellow, lch: lch });

    // Quality gates first
    if (stats) {
      if (stats.clippedFrac > t.maxClippedFrac) reasons.push('too many saturated pixels (glare)');
      if (stats.spreadL !== null && stats.spreadL > t.maxSpreadL) reasons.push('region not uniform (edge, label or glare inside)');
    }
    if (lch.L < t.minL) reasons.push('too dark');
    if (lch.L > t.maxL) reasons.push('too bright');

    const growthHue = hueIn(lch.h, t.growthHueMin, t.growthHueMax);
    const purpleHue = hueIn(lch.h, t.purpleHueMin, t.purpleHueMax);

    // A clear colour change is reported even if quality is imperfect (fail-safe direction).
    if (growthHue && lch.C >= t.minChroma) {
      reasons.unshift('hue in yellow/green band');
      return out('growth');
    }
    if (reasons.length) return out('uncertain');

    if (lch.C < t.minChroma) {
      reasons.push('colour too grey (low chroma)');
      return out('uncertain');
    }

    if (purpleHue) {
      if (dePurple !== null) {
        if (dePurple > t.maxDePurple) {
          reasons.push('hue is purple but too far from purple reference');
          return out('uncertain');
        }
        if (deYellow !== null && deYellow - dePurple < t.marginDe) {
          reasons.push('not clearly closer to purple than to yellow reference');
          return out('uncertain');
        }
      }
      reasons.push(dePurple !== null ? 'hue in purple band, matches purple reference' : 'hue in purple band (not calibrated)');
      return out('no_growth');
    }

    // Outside both hue bands
    if (deYellow !== null && deYellow <= t.maxDeYellow && (dePurple === null || deYellow < dePurple)) {
      reasons.push('closest to yellow reference');
      return out('growth');
    }
    reasons.push('hue outside purple and yellow/green bands');
    return out('uncertain');
  }

  // ---------- Sheet analysis (Bowie & Dick: pink stripes -> uniformly black) ----------
  const SHEET_DEFAULTS = {
    insetFrac: 0.04,        // ignore this share of the selected rectangle at each edge
    grid: 5,                // grid x grid cells
    inkDeltaL: 25,          // a pixel is "stripe" if its relative L* is this much below the local paper
    minInkFrac: 0.08,       // fewer stripe pixels than this share = wrong region
    minInkPerCell: 30,      // cells with fewer stripe pixels are ignored
    pinkChroma: 20,         // stripe pixel counts as pink at or above this chroma ...
    pinkHueMin: 300,        // ... with hue in this band (magenta-pink-red)
    pinkHueMax: 40,
    passPinkFrac: 0.02,     // pass: pink share of stripe pixels, whole sheet
    passCellPinkFrac: 0.05, // pass: pink share in the worst cell
    passInkL: 38,           // pass: median stripe darkness (relative L*), lower = blacker
    passWorstCellL: 48,     // pass: the lightest area's stripe darkness must still be at or below this (black enough)
    failPinkFrac: 0.10,     // fail: pink share, whole sheet
    failCellPinkFrac: 0.20, // fail: pink share in any cell
    failInkL: 60,           // fail: stripes clearly not dark
    failSpreadL: 20,        // fail: clearly uneven darkening (e.g. lighter centre), when the lightest area is not black
    passInkRatio: 0.6,      // pass: every cell has at least this share of the typical stripe density
    failInkRatio: 0.35,     // fail: a cell with less stripe density than this = faint / unchanged area
    maxClippedFrac: 0.15,   // glare
  };

  function percentile(sorted, p) {
    if (!sorted.length) return 0;
    const i = Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * p)));
    return sorted[i];
  }
  function median(arr) {
    if (!arr.length) return null;
    const s = Float64Array.from(arr).sort();
    return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
  }
  const yToL = (Y) => (Y > 216 / 24389 ? 116 * Math.cbrt(Y) - 16 : (24389 / 27) * Y);

  /**
   * Glare = all three channels saturated (a vivid pink may saturate one channel and is still analysed).
   * Analyse a test sheet inside rect {x0, y0, x1, y1} (pixel coords).
   * Darkness is measured relative to the local paper white of each cell, so uneven lighting
   * across the sheet is not mistaken for uneven darkening. Colour (pink) is measured after
   * correcting with the sheet's own paper white.
   */
  function analyseSheet(data, width, height, rect, thresholds) {
    const t = Object.assign({}, SHEET_DEFAULTS, thresholds || {});
    const rw = rect.x1 - rect.x0, rh = rect.y1 - rect.y0;
    const x0 = Math.max(0, Math.round(rect.x0 + rw * t.insetFrac));
    const y0 = Math.max(0, Math.round(rect.y0 + rh * t.insetFrac));
    const x1 = Math.min(width, Math.round(rect.x1 - rw * t.insetFrac));
    const y1 = Math.min(height, Math.round(rect.y1 - rh * t.insetFrac));
    const G = Math.max(1, Math.round(t.grid));
    const cw = (x1 - x0) / G, ch = (y1 - y0) / G;
    const step = Math.max(1, Math.floor(Math.sqrt(((x1 - x0) * (y1 - y0)) / 160000)));
    if (x1 - x0 < 20 || y1 - y0 < 20) return { error: 'Selected area too small.' };

    // Pass 1: luminance per cell, paper colour
    const cellY = Array.from({ length: G * G }, () => []);
    let total = 0, clipped = 0;
    const allY = [];
    for (let y = y0; y < y1; y += step) {
      for (let x = x0; x < x1; x += step) {
        const i = (y * width + x) * 4;
        const r = data[i], g = data[i + 1], b = data[i + 2];
        total++;
        if (r >= 250 && g >= 250 && b >= 250) { clipped++; continue; }
        const Y = 0.2126729 * LIN[r] + 0.7151522 * LIN[g] + 0.072175 * LIN[b];
        const c = Math.min(G - 1, Math.floor((y - y0) / ch)) * G + Math.min(G - 1, Math.floor((x - x0) / cw));
        cellY[c].push(Y);
        allY.push(Y);
      }
    }
    if (!allY.length) return { error: 'Area fully saturated (glare).' };
    allY.sort((a, b) => a - b);
    const paperYGlobal = percentile(allY, 0.9);
    const cellPaper = cellY.map((ys) => {
      if (ys.length < 10) return paperYGlobal;
      const s = Float64Array.from(ys).sort();
      return Math.max(percentile(s, 0.9), 1e-4);
    });
    // Paper colour = mean of the brightest 10% (unclipped)
    let pr = 0, pg = 0, pb = 0, pn = 0;
    for (let y = y0; y < y1; y += step) {
      for (let x = x0; x < x1; x += step) {
        const i = (y * width + x) * 4;
        const r = data[i], g = data[i + 1], b = data[i + 2];
        if (r >= 250 && g >= 250 && b >= 250) continue;
        const Y = 0.2126729 * LIN[r] + 0.7151522 * LIN[g] + 0.072175 * LIN[b];
        if (Y >= paperYGlobal) { pr += LIN[r]; pg += LIN[g]; pb += LIN[b]; pn++; }
      }
    }
    const paperLin = pn ? [pr / pn, pg / pn, pb / pn] : [1, 1, 1];

    // Pass 2: stripe pixels, pink vs dark, per cell
    const cells = Array.from({ length: G * G }, (_, c) => ({
      col: c % G, row: Math.floor(c / G),
      box: [x0 + (c % G) * cw, y0 + Math.floor(c / G) * ch, x0 + ((c % G) + 1) * cw, y0 + (Math.floor(c / G) + 1) * ch],
      n: 0, ink: 0, pink: 0, inkL: [],
    }));
    let ink = 0, pink = 0;
    for (let y = y0; y < y1; y += step) {
      for (let x = x0; x < x1; x += step) {
        const i = (y * width + x) * 4;
        const r = data[i], g = data[i + 1], b = data[i + 2];
        if (r >= 250 && g >= 250 && b >= 250) continue;
        const c = Math.min(G - 1, Math.floor((y - y0) / ch)) * G + Math.min(G - 1, Math.floor((x - x0) / cw));
        const cell = cells[c];
        cell.n++;
        const Y = 0.2126729 * LIN[r] + 0.7151522 * LIN[g] + 0.072175 * LIN[b];
        const Lrel = yToL(Math.min(1, Y / cellPaper[c]));
        if (Lrel > 100 - t.inkDeltaL) continue;
        cell.ink++; ink++;
        cell.inkL.push(Lrel);
        const lab = linRgbToLab(applyWhiteReference([LIN[r], LIN[g], LIN[b]], paperLin, 0.85));
        const lch = labToLch(lab);
        if (lch.C >= t.pinkChroma && hueIn(lch.h, t.pinkHueMin, t.pinkHueMax)) { cell.pink++; pink++; }
      }
    }

    const counted = total - clipped;
    const inkFrac = counted ? ink / counted : 0;
    const pinkFrac = ink ? pink / ink : 0;
    const used = cells.filter((c) => c.ink >= t.minInkPerCell);
    used.forEach((c) => { c.pinkFrac = c.pink / c.ink; c.medianL = median(c.inkL); });
    cells.forEach((c) => { delete c.inkL; });
    const meds = used.map((c) => c.medianL);
    const medianInkL = meds.length ? median(meds) : null;
    const worstCellL = meds.length ? Math.max.apply(null, meds) : null;
    const bestCellL = meds.length ? Math.min.apply(null, meds) : null;
    const spreadL = meds.length ? worstCellL - bestCellL : null;
    const maxCellPink = used.length ? Math.max.apply(null, used.map((c) => c.pinkFrac)) : null;
    const clippedFrac = total ? clipped / total : 0;
    // Stripe density per cell vs. the typical cell: catches areas where stripes stayed too light to count
    const dens = cells.filter((c) => c.n >= 20).map((c) => { c.inkDensity = c.ink / c.n; return c.inkDensity; });
    const typicalDensity = dens.length ? median(dens) : 0;
    const minInkRatio = typicalDensity > 0 ? Math.min.apply(null, dens) / typicalDensity : 0;
    const paperLab = linRgbToLab(paperLin);

    const metrics = { inkFrac, pinkFrac, minInkRatio, maxCellPink, medianInkL, spreadL, worstCellL, bestCellL, clippedFrac, cellsUsed: used.length, cellsTotal: G * G, paperLin, paperLab, step };
    const reasons = [];
    const res = (cls) => ({ cls, reasons, metrics, cells, rect: { x0, y0, x1, y1 } });

    if (inkFrac < t.minInkFrac || used.length < Math.ceil(G * G * 0.4)) {
      reasons.push('too few stripe pixels: select the printed pattern only');
      return res('uncertain');
    }
    // Fail checks first (fail-safe direction)
    if (pinkFrac >= t.failPinkFrac) reasons.push('pink remaining (' + Math.round(pinkFrac * 100) + '% of stripes)');
    else if (maxCellPink >= t.failCellPinkFrac) reasons.push('pink remaining in part of the sheet (worst area ' + Math.round(maxCellPink * 100) + '%)');
    // Uneven darkening only fails if the lightest area is not black (black vs. slightly less black is fine)
    if (spreadL >= t.failSpreadL && worstCellL > t.passWorstCellL) reasons.push('uneven darkening: lightest area L* ' + worstCellL.toFixed(0) + ' (ΔL* ' + spreadL.toFixed(0) + ')');
    if (medianInkL >= t.failInkL) reasons.push('stripes not dark (L* ' + medianInkL.toFixed(0) + ')');
    if (minInkRatio < t.failInkRatio) reasons.push('stripes faint or missing in part of the sheet');
    if (reasons.length) return res('fail');

    if (clippedFrac > t.maxClippedFrac) reasons.push('glare on the sheet');
    if (pinkFrac > t.passPinkFrac || maxCellPink > t.passCellPinkFrac) reasons.push('some pink detected');
    if (worstCellL > t.passWorstCellL) reasons.push('an area is not fully black (L* ' + worstCellL.toFixed(0) + ')');
    if (medianInkL > t.passInkL) reasons.push('stripes not fully black');
    if (minInkRatio < t.passInkRatio) reasons.push('stripe density uneven');
    if (reasons.length) return res('uncertain');
    reasons.push('uniform black, no pink');
    return res('pass');
  }


  const api = {
    srgbToLinear, linearToSrgb, linRgbToXyz, xyzToLab, linRgbToLab, srgbToLab, labToLch,
    deltaE2000, regionStats, applyWhiteReference, classify, hueIn, analyseSheet,
    DEFAULT_THRESHOLDS, SHEET_DEFAULTS,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Colour = api;
})(typeof window !== 'undefined' ? window : this);
