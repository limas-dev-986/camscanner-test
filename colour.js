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

  const MESSAGES = {
    no_growth: 'Fără creștere bacteriană - Procesul a avut succes',
    growth: 'Creștere bacteriană - Proces eșuat!',
    uncertain: 'Rezultat incert - Repetați citirea',
  };

  const api = {
    srgbToLinear, linearToSrgb, linRgbToXyz, xyzToLab, linRgbToLab, srgbToLab, labToLch,
    deltaE2000, regionStats, applyWhiteReference, classify, hueIn,
    DEFAULT_THRESHOLDS, MESSAGES,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Colour = api;
})(typeof window !== 'undefined' ? window : this);
