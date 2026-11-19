// Run with: node tests/colour.test.js
'use strict';
const C = require('../colour.js');

let failed = 0;
function check(name, cond, detail) {
  if (cond) console.log('ok   ' + name);
  else { failed++; console.log('FAIL ' + name + (detail ? '  ' + detail : '')); }
}
const near = (a, b, tol) => Math.abs(a - b) <= tol;

// CIEDE2000 reference pairs (Sharma, Wu & Dalal 2005)
const pairs = [
  [[50, 2.6772, -79.7751], [50, 0, -82.7485], 2.0425],
  [[50, 0, 0], [50, -1, 2], 2.3669],
  [[50, 2.49, -0.001], [50, -2.49, 0.0009], 7.1792],
  [[50, 2.5, 0], [73, 25, -18], 27.1492],
  [[60.2574, -34.0099, 36.2677], [60.4626, -34.1751, 39.4387], 1.2644],
  [[22.7233, 20.0904, -46.694], [23.0331, 14.973, -42.5619], 2.0373],
];
pairs.forEach(([p, q, exp], i) => {
  const d = C.deltaE2000({ L: p[0], a: p[1], b: p[2] }, { L: q[0], a: q[1], b: q[2] });
  check('CIEDE2000 pair ' + (i + 1), near(d, exp, 1e-3), 'got ' + d.toFixed(4) + ' expected ' + exp);
});

// sRGB -> Lab
const w = C.srgbToLab(255, 255, 255);
check('white -> L100 a0 b0', near(w.L, 100, 0.01) && near(w.a, 0, 0.01) && near(w.b, 0, 0.01), JSON.stringify(w));
const r = C.srgbToLab(255, 0, 0);
check('red -> 53.24/80.09/67.20', near(r.L, 53.24, 0.05) && near(r.a, 80.09, 0.1) && near(r.b, 67.2, 0.1), JSON.stringify(r));

// White reference correction removes a colour cast
const cast = [0.6, 0.5, 0.35]; // warm-lit white label
const corrected = C.applyWhiteReference(cast, cast, 0.85);
check('white ref -> neutral', corrected.every((v) => near(v, 0.85, 1e-9)));

// Classification without calibration (sample colours)
const cls = (rgb) => C.classify(C.srgbToLab(...rgb), { spreadL: 2, clippedFrac: 0 }, null).cls;
check('purple liquid (photo) -> no_growth', cls([147, 90, 210]) === 'no_growth');
check('darker purple -> no_growth', cls([90, 50, 140]) === 'no_growth');
check('yellow -> growth', cls([220, 200, 60]) === 'growth');
check('greenish -> growth', cls([120, 150, 80]) === 'growth');
check('olive -> growth', cls([150, 140, 70]) === 'growth');
check('grey -> uncertain', cls([128, 128, 128]) === 'uncertain');
check('grey-purple, low chroma -> uncertain', cls([128, 120, 135]) === 'uncertain');
check('pink/red -> uncertain', cls([220, 80, 110]) === 'uncertain');

// Quality gates
const lab = C.srgbToLab(147, 90, 210);
check('glare -> uncertain', C.classify(lab, { spreadL: 2, clippedFrac: 0.5 }, null).cls === 'uncertain');
check('non-uniform -> uncertain', C.classify(lab, { spreadL: 25, clippedFrac: 0 }, null).cls === 'uncertain');
const yl = C.srgbToLab(220, 200, 60);
check('yellow with glare still -> growth (fail-safe)', C.classify(yl, { spreadL: 25, clippedFrac: 0.5 }, null).cls === 'growth');

// Calibrated
const refs = { purple: C.srgbToLab(147, 90, 210), yellow: C.srgbToLab(220, 200, 60) };
check('calibrated purple -> no_growth', C.classify(C.srgbToLab(140, 85, 200), { spreadL: 2, clippedFrac: 0 }, refs).cls === 'no_growth');
check('calibrated: purple hue far from ref -> uncertain', C.classify(C.srgbToLab(60, 30, 90), { spreadL: 2, clippedFrac: 0 }, refs).cls === 'uncertain');

// Region stats on a synthetic image
const W = 10, H = 10, data = new Uint8ClampedArray(W * H * 4);
for (let i = 0; i < W * H; i++) { data[i * 4] = 147; data[i * 4 + 1] = 90; data[i * 4 + 2] = 210; data[i * 4 + 3] = 255; }
const st = C.regionStats(data, W, H, 5, 5, 6);
check('regionStats mean', st.srgb.every((v, i) => near(v, [147, 90, 210][i], 0.5)) && st.spreadL < 1e-6 && st.clippedFrac === 0);

// ---------- Bowie & Dick sheet ----------
// Synthetic chevron/X stripe pattern. ink(x, y) returns the stripe colour at a point; paper(x, y) the paper.
function sheet(ink, paper, light) {
  const w = 300, h = 240, d = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const u = x - w / 2, v = y - h / 2;
    const s = Math.abs(u) > Math.abs(v) * 1.25 ? Math.abs(u) + Math.abs(v) : Math.abs(v) - Math.abs(u) * 0.8 + 400;
    const stripe = Math.floor(s / 6) % 2 === 0;
    let c = stripe ? ink(x / w, y / h) : paper(x / w, y / h);
    const k = light ? light(x / w, y / h) : 1;
    const i = (y * w + x) * 4;
    d[i] = c[0] * k; d[i + 1] = c[1] * k; d[i + 2] = c[2] * k; d[i + 3] = 255;
  }
  return C.analyseSheet(d, w, h, { x0: 0, y0: 0, x1: w, y1: h });
}
const WHITE = () => [238, 236, 232];
const BLACK = () => [22, 22, 24];
const PINK = () => [235, 60, 150];
const centre = (inside, outside) => (x, y) => (Math.abs(x - 0.5) < 0.17 && Math.abs(y - 0.5) < 0.17 ? inside : outside);
const sheetCase = (name, r, exp) => check('sheet: ' + name + ' -> ' + exp, r.cls === exp, 'got ' + r.cls + ' ' + (r.reasons || []).join('; ') + ' ' + JSON.stringify(r.metrics && { p: r.metrics.pinkFrac, L: r.metrics.medianInkL, s: r.metrics.spreadL, d: r.metrics.minInkRatio }));
sheetCase('uniform black', sheet(BLACK, WHITE), 'pass');
sheetCase('all pink (unprocessed)', sheet(PINK, WHITE), 'fail');
sheetCase('lighter grey centre', sheet(centre([120, 120, 120], [22, 22, 24]), WHITE), 'fail');
sheetCase('faint centre', sheet(centre([205, 203, 200], [22, 22, 24]), WHITE), 'fail');
sheetCase('pink patch in centre', sheet(centre([235, 60, 150], [22, 22, 24]), WHITE), 'fail');
sheetCase('uniform black, uneven lighting', sheet(BLACK, WHITE, (x) => 0.55 + 0.45 * x), 'pass');
sheetCase('uniform black, warm light', sheet(() => [30, 24, 14], () => [245, 222, 170]), 'pass');
sheetCase('pink, warm light', sheet(() => [250, 70, 90], () => [245, 222, 170]), 'fail');
sheetCase('black, one area slightly less black', sheet(centre([70, 70, 72], [22, 22, 24]), WHITE), 'pass');
sheetCase('black, grey centre (L* ~50)', sheet(centre([110, 110, 112], [22, 22, 24]), WHITE), 'uncertain');
sheetCase('black, light grey centre (L* ~60)', sheet(centre([140, 140, 142], [22, 22, 24]), WHITE), 'fail');
sheetCase('black, overexposed paper (pure white)', sheet(() => [70, 70, 72], () => [255, 255, 255]), 'pass');
sheetCase('pink, overexposed paper', sheet(PINK, () => [255, 255, 255]), 'fail');
sheetCase('black, reflection hides centre stripes', sheet(centre([255, 255, 255], [22, 22, 24]), WHITE), 'fail');
sheetCase('grey stripes (L* ~55)', sheet(() => [125, 125, 127], WHITE), 'uncertain');
sheetCase('uniform dark grey (L* ~44)', sheet(() => [95, 95, 95], WHITE), 'pass');
const blank = new Uint8ClampedArray(100 * 100 * 4).fill(235);
check('sheet: blank paper -> uncertain', C.analyseSheet(blank, 100, 100, { x0: 0, y0: 0, x1: 100, y1: 100 }).cls === 'uncertain');

console.log(failed ?'\n' + failed + ' test(s) failed' : '\nall tests passed');
process.exit(failed ? 1 : 0);
