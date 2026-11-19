// Run with: node tests/detect.test.js   (add a path to also write PPM images of each scene there)
'use strict';
const D = require('../detect.js');
const C = require('../colour.js');
const fs = require('fs');
const outDir = process.argv[2];

let failed = 0;
function check(name, cond, detail) {
  if (cond) console.log('ok   ' + name);
  else { failed++; console.log('FAIL ' + name + (detail ? '  ' + detail : '')); }
}

// Deterministic noise
let seed = 12345;
const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296 - 0.5);

// Stripe pattern in pattern space (u, v in 0..1), aspect 4:3
function isStripe(u, v) {
  const x = (u - 0.5) * 400, y = (v - 0.5) * 300;
  const s = Math.abs(x) > Math.abs(y) * 1.25 ? Math.abs(x) + Math.abs(y) : Math.abs(y) - Math.abs(x) * 0.8 + 400;
  return Math.floor(s / 8) % 2 === 0;
}

/** Render a card (pattern + white margin) into a w x h frame at the given pattern corners [TL, TR, BR, BL]. */
function scene(corners, ink, opts) {
  const o = Object.assign({ w: 640, h: 480, table: [120, 112, 100], noise: 10, margin: 0.05 }, opts || {});
  const inv = D.quadToSquare(corners);
  const d = new Uint8ClampedArray(o.w * o.h * 4);
  for (let y = 0; y < o.h; y++) for (let x = 0; x < o.w; x++) {
    // 2x2 supersampling for soft edges
    let r = 0, g = 0, b = 0;
    for (let k = 0; k < 4; k++) {
      const uv = inv(x + 0.25 + 0.5 * (k & 1), y + 0.25 + 0.5 * (k >> 1));
      const u = uv[0], v = uv[1];
      let c;
      if (u < -o.margin || u > 1 + o.margin || v < -o.margin || v > 1 + o.margin) c = o.table;
      else if (u < 0 || u > 1 || v < 0 || v > 1) c = [236, 233, 226];
      else c = isStripe(u, v) ? ink(u, v) : [236, 233, 226];
      r += c[0]; g += c[1]; b += c[2];
    }
    const nz = rnd() * o.noise, i = (y * o.w + x) * 4;
    d[i] = r / 4 + nz; d[i + 1] = g / 4 + nz; d[i + 2] = b / 4 + nz; d[i + 3] = 255;
  }
  if (outDir) {
    const name = outDir + '/scene_' + (scene.n = (scene.n || 0) + 1) + '.ppm';
    const buf = Buffer.alloc(o.w * o.h * 3);
    for (let i = 0, j = 0; i < d.length; i += 4) { buf[j++] = d[i]; buf[j++] = d[i + 1]; buf[j++] = d[i + 2]; }
    fs.writeFileSync(name, Buffer.concat([Buffer.from('P6\n' + o.w + ' ' + o.h + '\n255\n'), buf]));
  }
  return { data: d, w: o.w, h: o.h };
}

const BLACK = () => [26, 26, 28];
const PINK = () => [232, 64, 150];
const centre = (inside, outside) => (u, v) => (Math.abs(u - 0.5) < 0.18 && Math.abs(v - 0.5) < 0.2 ? inside : outside);

function rot(cx, cy, w, h, deg) {
  const a = (deg * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
  return [[-w / 2, -h / 2], [w / 2, -h / 2], [w / 2, h / 2], [-w / 2, h / 2]].map(([x, y]) => ({ x: cx + x * c - y * s, y: cy + x * s + y * c }));
}

function run(name, corners, ink, expectCls, opts) {
  const sc = scene(corners, ink, opts);
  const det = D.detectPattern(sc.data, sc.w, sc.h);
  if (!det.found) { check(name + ': detected', false, det.reason); return; }
  // each true corner must have a detected corner nearby (order may differ for upright cards)
  const err = Math.max.apply(null, corners.map((p) => Math.min.apply(null, det.corners.map((c) => Math.hypot(p.x - c.x, p.y - c.y)))));
  check(name + ': corners within 3% (' + err.toFixed(1) + ' px)', err <= 0.03 * sc.w, JSON.stringify(det.corners.map((p) => [Math.round(p.x), Math.round(p.y)])));
  const r = D.rectify(sc.data, sc.w, sc.h, det.corners, 900);
  const res = C.analyseSheet(r.data, r.width, r.height, { x0: 0, y0: 0, x1: r.width, y1: r.height });
  check(name + ': reads ' + expectCls, res.cls === expectCls, 'got ' + res.cls + ' ' + (res.reasons || []).join('; '));
  return det;
}

run('straight black', rot(320, 240, 400, 300, 0), BLACK, 'pass');
run('rotated 12°, black', rot(320, 240, 380, 285, 12), BLACK, 'pass');
run('rotated -25°, pink', rot(320, 240, 340, 255, -25), PINK, 'fail');
const tilted = [{ x: 150, y: 110 }, { x: 490, y: 110 }, { x: 540, y: 390 }, { x: 100, y: 390 }]; // keystone
const dk = run('tilted (keystone), black', tilted, BLACK, 'pass');
if (dk) check('tilted: side ratio reported > 1.15', dk.sideRatio > 1.15, String(dk.sideRatio));
run('tilted + rotated, grey centre', [{ x: 190, y: 90 }, { x: 500, y: 140 }, { x: 490, y: 400 }, { x: 110, y: 350 }], centre([145, 145, 147], [26, 26, 28]), 'fail');
run('faded centre (hole in texture)', rot(320, 240, 400, 300, 5), centre([225, 222, 216], [26, 26, 28]), 'fail');
run('black on dark noisy table', rot(320, 240, 400, 300, -8), BLACK, 'pass', { table: [45, 42, 40], noise: 16 });
run('black on white table', rot(320, 240, 400, 300, 8), BLACK, 'pass', { table: [225, 225, 222], noise: 8 });
const up = run('upright card (portrait in frame)', rot(320, 240, 300, 400, 3).slice(0), BLACK, 'pass', { w: 640, h: 480 });

// Upright: long side becomes the width, so aspect stays > 1
const scU = scene(rot(320, 240, 255, 340, 2), BLACK);
const dU = D.detectPattern(scU.data, scU.w, scU.h);
check('upright pattern: aspect normalised (> 1)', dU.found && dU.aspect > 1.15 && dU.aspect < 1.5, JSON.stringify(dU.aspect));

// Border + nothing there
const cut = scene(rot(560, 240, 400, 300, 0), BLACK);
const dc = D.detectPattern(cut.data, cut.w, cut.h);
check('pattern cut by frame edge: touchesBorder', dc.found && dc.touchesBorder);
const empty = scene(rot(-2000, -2000, 10, 10, 0), BLACK);
check('no pattern: not found', !D.detectPattern(empty.data, empty.w, empty.h).found);
const small = scene(rot(320, 240, 400, 300, 0), BLACK);
check('straight: aspect ~1.33, not touching border', (() => { const d = D.detectPattern(small.data, small.w, small.h); return Math.abs(d.aspect - 1.333) < 0.08 && !d.touchesBorder && d.sideRatio < 1.08; })());

// Homography round trip
const q = [{ x: 10, y: 20 }, { x: 300, y: 40 }, { x: 320, y: 260 }, { x: 0, y: 200 }];
const f = D.squareToQuad(q), g = D.quadToSquare(q), p = f(0.3, 0.7), b = g(p[0], p[1]);
check('homography round trip', Math.abs(b[0] - 0.3) < 1e-9 && Math.abs(b[1] - 0.7) < 1e-9);

console.log(failed ? '\n' + failed + ' test(s) failed' : '\nall tests passed');
process.exit(failed ? 1 : 0);
