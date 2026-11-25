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

// ---------- Indicator fields (three triangles) ----------
function strip(colours, opts) {
  const o = Object.assign({ w: 720, h: 540, rot: 0, table: [40, 38, 36] }, opts || {});
  const d = new Uint8ClampedArray(o.w * o.h * 4), a = (o.rot * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
  const tri = [[-150, -50], [-185, 20], [-115, 20]]; // triangle centres in label coords (label 480 x 180, centred)
  for (let y = 0; y < o.h; y++) for (let x = 0; x < o.w; x++) {
    const dx = x - o.w / 2, dy = y - o.h / 2, u = dx * c + dy * s, v = -dx * s + dy * c;
    let col = o.table;
    if (Math.abs(u) < 240 && Math.abs(v) < 90) {
      col = [238, 236, 232];
      if (u > -60 && u < 200 && v > -70 && v < -30) col = [20, 60, 200];          // vivid logo: must be ignored
      if (u > -60 && u < 20 && v > 0 && v < 70 && ((u + v) | 0) % 6 < 3) col = [20, 20, 20]; // code block
      tri.forEach((t, i) => { const tx = u - t[0], ty = v - t[1]; if (ty > -30 && ty < 26 && Math.abs(tx) < (ty + 30) * 0.55) col = colours[i]; });
    }
    const nz = rnd() * 8, i = (y * o.w + x) * 4;
    d[i] = col[0] + nz; d[i + 1] = col[1] + nz; d[i + 2] = col[2] + nz; d[i + 3] = 255;
  }
  return { data: d, w: o.w, h: o.h };
}
const TPK = [222, 178, 200], TBL = [176, 180, 205];
[['three pink', [TPK, TPK, TPK], 0], ['three blue, rotated 20°', [TBL, TBL, TBL], 20], ['mixed, rotated -35°', [TPK, TBL, TPK], -35]].forEach(([name, cols, rot]) => {
  const sc = strip(cols, { rot });
  const r = D.detectPatches(sc.data, sc.w, sc.h);
  check('fields: ' + name + ' -> three found', r.found && r.fields.length === 3 && !r.multiple && !r.touchesBorder, JSON.stringify(r).slice(0, 200));
  if (r.found) {
    const a = (rot * Math.PI) / 180, exp = [[-150, -50], [-185, 20], [-115, 20]].map(([u, v]) => [sc.w / 2 + u * Math.cos(a) - v * Math.sin(a), sc.h / 2 + u * Math.sin(a) + v * Math.cos(a)]);
    const err = Math.max.apply(null, exp.map((e) => Math.min.apply(null, r.fields.map((f) => Math.hypot(f.x - e[0], f.y - e[1])))));
    check('fields: ' + name + ' -> centres within 12 px (' + err.toFixed(1) + ')', err < 12);
  }
});
const noTri = strip([[238, 236, 232], [238, 236, 232], [238, 236, 232]]);
check('fields: label without triangles -> not found', !D.detectPatches(noTri.data, noTri.w, noTri.h).found);

// ---- Type 5 label found by its black title band (label-first detection) ----
// Label drawn in band units: band length = 1, origin at the band centre, upright = triangles on the left.
const TRI_UV = [[-0.768, -0.053], [-0.839, 0.092], [-0.701, 0.092]];
function inTriangle(u, v, c, side) { // equilateral, apex up
  const h = side * 0.866, top = c[1] - h * 0.6, bot = c[1] + h * 0.4;
  if (v < top || v > bot) return false;
  return Math.abs(u - c[0]) <= ((v - top) / h) * side / 2;
}
function labelColour(u, v, tri, qrBits) {
  if (u < -0.99 || u > 0.86 || v < -0.29 || v > 0.42) return null;
  if (Math.abs(u) <= 0.5 && Math.abs(v) <= 0.041) return Math.abs(v) < 0.015 && Math.floor(u * 40) % 3 === 0 ? [235, 235, 235] : [20, 20, 22];
  for (const c of TRI_UV) if (inTriangle(u, v, c, 0.115)) return tri;
  const qu = (u + 0.407) / 0.14 + 0.5, qv = (v - 0.225) / 0.14 + 0.5;
  if (qu >= 0 && qu < 1 && qv >= 0 && qv < 1) return qrBits[Math.floor(qv * 9) * 9 + Math.floor(qu * 9)] ? [25, 25, 25] : [240, 240, 238];
  if (Math.abs(u + 0.77) < 0.07 && Math.abs(v - 0.225) < 0.009) return [25, 25, 25];
  return [240, 240, 238];
}
function labelScene(labels, opts) {
  const o = Object.assign({ w: 640, h: 480, bg: [170, 185, 200], noise: 6 }, opts || {});
  const qrBits = []; for (let i = 0; i < 81; i++) qrBits.push(rnd() > 0);
  const d = new Uint8ClampedArray(o.w * o.h * 4), truth = [];
  labels.forEach((L) => { const a = L.deg * Math.PI / 180, c = Math.cos(a), s = Math.sin(a); truth.push(TRI_UV.map((t) => ({ x: L.cx + (t[0] * c - t[1] * s) * L.len, y: L.cy + (t[0] * s + t[1] * c) * L.len }))); });
  for (let y = 0; y < o.h; y++) for (let x = 0; x < o.w; x++) {
    let col = o.bg;
    for (const L of labels) {
      const a = L.deg * Math.PI / 180, c = Math.cos(a), s = Math.sin(a), dx = (x + 0.5 - L.cx) / L.len, dy = (y + 0.5 - L.cy) / L.len;
      const k = labelColour(dx * c + dy * s, -dx * s + dy * c, L.tri, qrBits);
      if (k) { col = k; break; }
    }
    const i = (y * o.w + x) * 4, n = rnd() * o.noise;
    d[i] = col[0] + n; d[i + 1] = col[1] + n; d[i + 2] = col[2] + n; d[i + 3] = 255;
  }
  return { data: d, w: o.w, h: o.h, truth };
}
const TBLUE = [150, 160, 205], TPINK = [225, 165, 195];
function stripCase(name, labels, expect, opts) {
  const sc = labelScene(labels, opts), r = D.detectStrip(sc.data, sc.w, sc.h);
  if (expect.found === false) { check('strip: ' + name + ' -> not found', !r.found, JSON.stringify(r).slice(0, 160)); return r; }
  check('strip: ' + name + ' -> found', r.found, JSON.stringify(r).slice(0, 160));
  if (!r.found) return r;
  const t = sc.truth[0], err = Math.max.apply(null, r.fields.map((f) => Math.min.apply(null, t.map((p) => Math.hypot(f.x - p.x, f.y - p.y)))));
  check('strip: ' + name + ' -> triangles within ' + (0.03 * labels[0].len).toFixed(0) + ' px (' + err.toFixed(1) + ')', err < 0.03 * labels[0].len);
  if ('multiple' in expect) check('strip: ' + name + ' -> multiple = ' + expect.multiple, r.multiple === expect.multiple);
  if ('border' in expect) check('strip: ' + name + ' -> touchesBorder = ' + expect.border, r.touchesBorder === expect.border);
  return r;
}
stripCase('upright, blue', [{ cx: 340, cy: 230, len: 300, deg: 0, tri: TBLUE }], { multiple: false, border: false });
stripCase('upside down, pink', [{ cx: 300, cy: 250, len: 300, deg: 180, tri: TPINK }], { multiple: false, border: false });
stripCase('rotated 25°, pink', [{ cx: 330, cy: 240, len: 260, deg: 25, tri: TPINK }], { border: false });
stripCase('portrait (90°), blue', [{ cx: 320, cy: 250, len: 230, deg: 90, tri: TBLUE }], { border: false });
stripCase('small (live frame size)', [{ cx: 180, cy: 135, len: 110, deg: 4, tri: TBLUE }], {}, { w: 360, h: 270 });
stripCase('two labels', [{ cx: 330, cy: 130, len: 260, deg: 0, tri: TBLUE }, { cx: 330, cy: 360, len: 260, deg: 0, tri: TPINK }], { multiple: true });
stripCase('triangles near frame edge', [{ cx: 285, cy: 240, len: 300, deg: 0, tri: TBLUE }], { border: true });
stripCase('label without triangles', [{ cx: 340, cy: 230, len: 300, deg: 0, tri: [240, 240, 238] }], { found: false });
const bdScene = scene(rot(320, 240, 400, 300, 0), BLACK), rbd = D.detectStrip(bdScene.data, bdScene.w, bdScene.h);
check('strip: black striped sheet -> not found', !rbd.found);
const pinkScene = scene(rot(320, 240, 400, 300, 0), PINK), rpk = D.detectStrip(pinkScene.data, pinkScene.w, pinkScene.h);
check('strip: pink striped sheet -> not found', !rpk.found);
// Manual tap: the box fits the tapped triangle
const tapSc = labelScene([{ cx: 340, cy: 230, len: 300, deg: 0, tri: TPINK }]);
const fa = D.fieldAt(tapSc.data, tapSc.w, tapSc.h, { x: tapSc.truth[0][1].x + 5, y: tapSc.truth[0][1].y + 3 });
check('tap: field found near tap', !!fa && Math.hypot(fa.x - tapSc.truth[0][1].x, fa.y - tapSc.truth[0][1].y) < 6, JSON.stringify(fa));
check('tap: size matches the triangle (34 px side)', !!fa && Math.abs(fa.side - 0.115 * 300) < 7, fa && fa.side.toFixed(1));

console.log(failed ? '\n' + failed + ' test(s) failed' : '\nall tests passed');
process.exit(failed ? 1 : 0);
