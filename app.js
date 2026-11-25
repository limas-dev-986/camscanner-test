/* Indicator colour test: UI. Depends on colour.js (window.Colour) and products.js (window.PRODUCTS). No network calls. */
(function () {
  'use strict';
  const C = window.Colour;
  const D = window.Detect;
  const PRODUCTS = window.PRODUCTS;
  const BUILD = '2026-11-25.2';
  const $ = (id) => document.getElementById(id);

  // ---------- storage (localStorage can be unavailable) ----------
  const store = {
    get(key, fallback) {
      try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; } catch (e) { return fallback; }
    },
    set(key, value) {
      try { localStorage.setItem(key, JSON.stringify(value)); return true; } catch (e) { return false; }
    },
  };
  const K = { log: 'bi-test-log', refs: 'bi-test-refs', thr: 'bi-test-thresholds-v5', thrOld: 'bi-test-thresholds', session: 'bi-test-session', cam: 'bi-test-best-camera' };

  // Each object carries its own colour rules (products.js); these are the defaults for the settings section.
  const rulesOf = (p) => p.rules;

  function loadThresholds() {
    const saved = store.get(K.thr, null) || {};
    const old = store.get(K.thrOld, null); // build .1 stored vial thresholds flat
    if (old && !saved['bi-vial']) saved['bi-vial'] = old;
    const v4 = store.get('bi-test-thresholds-v4', null); // sheet values reset again in build 2026-11-24.6 (tightened)
    if (v4) ['bi-vial', 't5-strip'].forEach((id) => { if (v4[id] && !saved[id]) saved[id] = v4[id]; });
    const v3 = store.get('bi-test-thresholds-v3', null); // sheet values reset again in build .8
    if (v3 && v3['bi-vial'] && !saved['bi-vial']) saved['bi-vial'] = v3['bi-vial'];
    const v2 = store.get('bi-test-thresholds-v2', null); // keep edited vial values; sheet values reset to new defaults (build .5)
    if (v2 && v2['bi-vial'] && !saved['bi-vial']) saved['bi-vial'] = v2['bi-vial'];
    const out = {};
    PRODUCTS.forEach((p) => { out[p.id] = Object.assign({}, rulesOf(p), saved[p.id] || {}); });
    return out;
  }

  // ---------- state ----------
  const state = {
    product: PRODUCTS[0],
    stream: null,
    track: null,
    imageCapture: null,
    frame: null,
    frameCanvas: null,
    roiIndicator: null,   // vial: {x, y}
    roiWhite: null,       // vial: {x, y} or 'skipped'
    corners: [],          // sheet: up to two {x, y}
    patchPts: [],         // patches: tapped field centres
    lastReading: null,
    capReport: {},
    log: store.get(K.log, []),
    refs: store.get(K.refs, { purple: [], yellow: [] }),
    thresholds: loadThresholds(),
    locks: { exposure: false, wb: false, focus: false, torch: false },
    tilt: null,           // { deg, beta, gamma, ts } from the motion sensor
    auto: { active: false, timer: null, last: null, stable: 0 },
  };
  const thr = () => state.thresholds[state.product.id];

  const video = $('video');
  const frameCanvas = $('frame');
  const ctx = frameCanvas.getContext('2d', { willReadFrequently: true });

  const fmt = (v, d) => (v === null || v === undefined || Number.isNaN(v) ? '' : Number(v).toFixed(d === undefined ? 1 : d));
  const pct = (v) => (v === null || v === undefined ? '' : Math.round(v * 1000) / 10 + '%');
  const round = (v, d) => (v === null || v === undefined || v === '' ? '' : Number(Number(v).toFixed(d === undefined ? 2 : d)));
  const nowIso = () => new Date().toISOString();
  // Interface text is Romanian; values stored in the log stay as stable English codes.
  const KIND_RO = { exposure: 'expunere', wb: 'balans de alb', focus: 'focalizare', torch: 'lanternă' };
  const REF_RO = { purple: 'violet', yellow: 'galben' };
  const CLS_RO = { pass: 'trecut', fail: 'eșuat', uncertain: 'incert', necitit: 'necitit', unknown: 'necunoscut', no_growth: 'trecut', growth: 'eșuat' };
  const optionText = (selectId, value) => { const o = Array.from($(selectId).options).find((x) => x.value === value); return o ? o.textContent : value; };

  // ======================================================================
  // Object (product) selection
  // ======================================================================
  function setProduct(id) {
    state.product = PRODUCTS.find((p) => p.id === id) || PRODUCTS[0];
    $('selProduct').value = state.product.id;
    const vial = state.product.method === 'vial';
    $('productHint').innerHTML = '<strong>' + escapeHtml(state.product.rulesText) + '</strong><br>' + escapeHtml(state.product.hint);
    $('roiSizeRow').classList.toggle('hidden', state.product.method === 'sheet');
    $('btnSkipWhite').classList.toggle('hidden', !vial);
    $('btnAutoRoi').classList.toggle('hidden', !state.product.autoRegion);
    $('autoLabel').classList.toggle('hidden', !state.product.autoRegion);
    stopAuto();
    $('calibBox').classList.toggle('hidden', !state.product.calibration);
    $('refSection').classList.toggle('hidden', !state.product.calibration);
    const exp = $('expected');
    exp.innerHTML = '<option value="">— selectați —</option>' +
      '<option value="pass">' + escapeHtml(state.product.expected.pass) + '</option>' +
      '<option value="fail">' + escapeHtml(state.product.expected.fail) + '</option>' +
      '<option value="unknown">Necunoscut</option>';
    resetRegions();
    renderThresholds();
    saveSession();
  }

  // ======================================================================
  // Camera
  // ======================================================================
  // ---- Best back camera: chosen automatically for every object ----
  // Phones expose several back cameras (main, ultra-wide, telephoto, macro, depth). For reading colours up close
  // the main camera is best: it has autofocus, the torch and the highest resolution. Each back camera is opened
  // briefly once, scored, and the choice is remembered for this set of cameras (re-checked if the list changes).
  const CAM_AVOID = /ultra.?wide|ultrawide|\buw\b|macro|depth|tele|zoom|infra|\bir\b|tof/i;
  function camIndex(label) { const m = /camera2?\s*(\d+)/i.exec(label || ''); return m ? +m[1] : 99; }
  function scoreCamera(c) {
    const caps = c.caps || {}, fm = caps.facingMode || [], label = c.label || '';
    const back = fm.indexOf('environment') !== -1 || /back|rear|environment|spate/i.test(label);
    const focus = caps.focusMode || [];
    const w = caps.width && caps.width.max || 0, h = caps.height && caps.height.max || 0;
    let s = 0;
    if (back) s += 1000;
    if (focus.indexOf('continuous') !== -1) s += 300; else if (focus.length > 1) s += 150;
    if ('torch' in caps) s += 100;
    s += Math.min(12, (w * h) / 1e6) * 10;
    if (CAM_AVOID.test(label)) s -= 400;
    if (/dual|triple/i.test(label)) s -= 50; // virtual cameras switch lenses on their own (colour may jump)
    s -= Math.min(camIndex(label), 20) * 5; // Android numbers the main back camera 0
    return Math.round(s);
  }
  async function probeCamera(dev) {
    let st = null;
    try {
      st = await navigator.mediaDevices.getUserMedia({ video: { deviceId: { exact: dev.deviceId } }, audio: false });
      const t = st.getVideoTracks()[0];
      return { deviceId: dev.deviceId, label: t.label || dev.label, caps: t.getCapabilities ? t.getCapabilities() : {} };
    } catch (e) { return { deviceId: dev.deviceId, label: dev.label, caps: {}, error: e.name };
    } finally { if (st) st.getTracks().forEach((t) => t.stop()); }
  }
  async function chooseBestCamera(status) {
    const devs = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'videoinput' && d.deviceId);
    if (devs.length < 2) return devs.length ? { deviceId: devs[0].deviceId, label: devs[0].label, ranked: [], cached: false } : null;
    const sig = devs.map((d) => d.deviceId).join('|');
    const cached = store.get(K.cam, null);
    if (cached && cached.sig === sig && devs.some((d) => d.deviceId === cached.deviceId)) return Object.assign({ cached: true }, cached);
    // Only test the back cameras when the labels say which they are; otherwise test all
    let cand = devs.filter((d) => !/front|user|selfie|fa[țt]ă/i.test(d.label));
    if (!cand.length) cand = devs;
    const ranked = [];
    for (let i = 0; i < cand.length; i++) {
      status.textContent = 'Se alege cea mai bună cameră (' + (i + 1) + ' din ' + cand.length + ')…';
      const c = await probeCamera(cand[i]);
      if (c.error) continue;
      c.score = scoreCamera(c);
      ranked.push({ deviceId: c.deviceId, label: c.label, score: c.score,
        res: (c.caps.width && c.caps.width.max || '?') + '×' + (c.caps.height && c.caps.height.max || '?'),
        focus: (c.caps.focusMode || []).join('/') || '—', torch: 'torch' in (c.caps || {}) });
    }
    if (!ranked.length) return null;
    ranked.sort((a, b) => b.score - a.score);
    const out = { sig, deviceId: ranked[0].deviceId, label: ranked[0].label, ranked, at: nowIso() };
    store.set(K.cam, out);
    return Object.assign({ cached: false }, out);
  }

  async function startCamera(deviceId) {
    const status = $('camStatus');
    if (!window.isSecureContext) { status.innerHTML = '<span class="warn">Pagina nu este deschisă printr-o conexiune securizată (HTTPS). Camera nu va funcționa.</span>'; return; }
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) { status.innerHTML = '<span class="warn">Acest browser nu permite accesul la cameră (getUserMedia).</span>'; return; }
    stopCamera();
    // No camera chosen in the list: pick the best back camera (same for every object)
    state.cameraChoice = null;
    if (!deviceId) {
      try {
        let ch = await chooseBestCamera(status);
        if (!ch) { // labels and ids are hidden until camera permission: ask once, then choose
          const tmp = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false });
          tmp.getTracks().forEach((t) => t.stop());
          ch = await chooseBestCamera(status);
        }
        if (ch) { deviceId = ch.deviceId; state.cameraChoice = ch; }
      } catch (e) { /* fall back to the browser's own back camera */ }
    } else state.cameraChoice = { manual: true };
    const video_c = deviceId
      ? { deviceId: { exact: deviceId }, width: { ideal: 1920 }, height: { ideal: 1080 } }
      : { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } };
    try {
      try {
        state.stream = await navigator.mediaDevices.getUserMedia({ video: video_c, audio: false });
      } catch (e) {
        if (!state.cameraChoice || state.cameraChoice.manual) throw e;
        store.set(K.cam, null); state.cameraChoice = null; // remembered camera no longer opens: let the browser choose
        state.stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } }, audio: false });
      }
    } catch (e) {
      status.innerHTML = '<span class="warn">Eroare la pornirea camerei: ' + escapeHtml(e.name + ' ' + e.message) + '</span>';
      return;
    }
    state.track = state.stream.getVideoTracks()[0];
    video.srcObject = state.stream;
    $('camWrap').classList.remove('hidden');
    $('camControls').classList.remove('hidden');
    try { await video.play(); } catch (e) { /* ignore */ }
    await new Promise((res) => { if (video.videoWidth) res(); else video.onloadedmetadata = () => res(); });
    state.locks = { exposure: false, wb: false, focus: false, torch: false };
    state.expComp = null;
    ['lockExposure', 'lockWB', 'lockFocus', 'torch'].forEach((id) => ($(id).checked = false));
    try { state.imageCapture = 'ImageCapture' in window ? new ImageCapture(state.track) : null; } catch (e) { state.imageCapture = null; }
    const ch = state.cameraChoice, nBack = ch && ch.ranked ? ch.ranked.length : 0;
    status.textContent = 'Cameră: ' + (state.track.label || 'fără nume') + ' · ' + video.videoWidth + '×' + video.videoHeight +
      (ch && ch.manual ? ' · aleasă manual' : ch && nBack > 1 ? ' · cea mai bună din ' + nBack + ' camere (aleasă automat)' : ch ? ' · aleasă automat' : '');
    $('btnStart').textContent = 'Repornește camera';
    await listCameras();
    updateLockAvailability();
    await refreshCapabilities();
    // Sheets with "Automat" ticked: scanning starts as soon as the camera runs (no extra tap)
    if (state.product.autoRegion && $('autoCapture').checked) startAuto();
  }

  function stopCamera() {
    stopAuto();
    if (state.stream) state.stream.getTracks().forEach((t) => t.stop());
    state.stream = null; state.track = null; state.imageCapture = null;
  }

  async function listCameras() {
    try {
      const devs = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'videoinput');
      const sel = $('selCamera');
      if (devs.length < 2) { sel.classList.add('hidden'); return; }
      const current = trackSettings().deviceId || '';
      sel.innerHTML = devs.map((d, i) => '<option value="' + escapeHtml(d.deviceId) + '"' + (d.deviceId === current ? ' selected' : '') + '>' +
        escapeHtml(d.label || 'Camera ' + (i + 1)) + '</option>').join('');
      sel.classList.remove('hidden');
    } catch (e) { /* ignore */ }
  }

  function trackCaps() {
    try { return state.track && state.track.getCapabilities ? state.track.getCapabilities() : {}; } catch (e) { return {}; }
  }
  function trackSettings() {
    try { return state.track && state.track.getSettings ? state.track.getSettings() : {}; } catch (e) { return {}; }
  }

  function updateLockAvailability() {
    const caps = trackCaps();
    const has = (k, v) => Array.isArray(caps[k]) && caps[k].indexOf(v) !== -1;
    $('lockExposure').disabled = !has('exposureMode', 'manual');
    $('lockWB').disabled = !has('whiteBalanceMode', 'manual');
    $('lockFocus').disabled = !has('focusMode', 'manual');
    $('torch').disabled = !('torch' in caps);
    const unsupported = [];
    if ($('lockExposure').disabled) unsupported.push('blocarea expunerii');
    if ($('lockWB').disabled) unsupported.push('blocarea balansului de alb');
    if ($('lockFocus').disabled) unsupported.push('blocarea focalizării');
    if ($('torch').disabled) unsupported.push('lanterna');
    $('lockStatus').textContent = unsupported.length ? 'Indisponibile pe acest telefon/browser: ' + unsupported.join(', ') + '.' : 'Toate reglajele camerei sunt disponibile.';
  }

  // Lock = switch to manual mode and pin the value the camera is using right now.
  async function setLock(kind, on) {
    if (!state.track) return;
    const s = trackSettings();
    const c = {};
    if (kind === 'exposure') {
      c.exposureMode = on ? 'manual' : 'continuous';
      if (on && s.exposureTime) c.exposureTime = s.exposureTime;
    } else if (kind === 'wb') {
      c.whiteBalanceMode = on ? 'manual' : 'continuous';
      if (on && s.colorTemperature) c.colorTemperature = s.colorTemperature;
    } else if (kind === 'focus') {
      c.focusMode = on ? 'manual' : 'continuous';
      if (on && s.focusDistance !== undefined) c.focusDistance = s.focusDistance;
    } else if (kind === 'torch') {
      c.torch = !!on;
    }
    try {
      await state.track.applyConstraints({ advanced: [c] });
      state.locks[kind] = on;
      $('lockStatus').textContent = KIND_RO[kind] + (on ? ': blocat / pornit' : ': automat / oprit') + ' · aplicat: ' + JSON.stringify(c);
    } catch (e) {
      state.locks[kind] = false;
      const box = { exposure: 'lockExposure', wb: 'lockWB', focus: 'lockFocus', torch: 'torch' }[kind];
      $(box).checked = false;
      $('lockStatus').innerHTML = '<span class="warn">Nu s-a putut aplica reglajul (' + KIND_RO[kind] + '): ' + escapeHtml(e.name + ' ' + e.message) + '</span>';
    }
  }

  // ======================================================================
  // Capture + regions
  // ======================================================================
  // Capture keeps the same centre crop the landscape preview shows (object-fit: cover)
  const CAPTURE_ASPECT = 4 / 3;
  // Grab the visible part of the video. outW = output width (omit for full resolution).
  function grabFrame(outW, canvas) {
    const vw = video.videoWidth, vh = video.videoHeight;
    let sw = vw, sh = vh;
    if (vw / vh > CAPTURE_ASPECT) sw = Math.round(vh * CAPTURE_ASPECT); else sh = Math.round(vw / CAPTURE_ASPECT);
    const sx = Math.round((vw - sw) / 2), sy = Math.round((vh - sh) / 2);
    const w = outW || sw, h = outW ? Math.round(outW / CAPTURE_ASPECT) : sh;
    const off = canvas || document.createElement('canvas');
    off.width = w; off.height = h;
    const octx = off.getContext('2d', { willReadFrequently: true });
    octx.drawImage(video, sx, sy, sw, sh, 0, 0, w, h);
    return { canvas: off, image: octx.getImageData(0, 0, w, h), vw, vh };
  }

  function capture(autoInfo) {
    if (!video.videoWidth) return;
    const g = grabFrame();
    const w = g.image.width, h = g.image.height, vw = g.vw, vh = g.vh;
    state.frameCanvas = g.canvas;
    state.frame = g.image;
    state.captureMeta = {
      autoCapture: !!autoInfo,
      autoWaitSec: autoInfo && state.auto.startedAt ? Math.round((Date.now() - state.auto.startedAt) / 100) / 10 : null,
      autoLastMessage: '',
      autoWaits: autoInfo && autoInfo.waits ? autoInfo.waits : null,
      tiltDeg: tiltFresh() ? state.tilt.deg : null,
      settings: trackSettings(),
      locks: Object.assign({}, state.locks),
      width: w, height: h, videoWidth: vw, videoHeight: vh,
      cameraLabel: state.track ? state.track.label : '',
      cameraChoice: state.cameraChoice ? (state.cameraChoice.manual ? 'manual' : 'auto') : 'browser',
    };
    frameCanvas.width = w; frameCanvas.height = h;
    resetRegions();
    $('roiSection').classList.remove('hidden');
    if (autoInfo) autoRegion();
    $('roiSection').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  // ======================================================================
  // Automatic capture (sheets): wait until the pattern is in view, the angle is right and the phone is still
  // ======================================================================
  const liveCanvas = document.createElement('canvas');
  const overlay = $('liveOverlay');
  const octxLive = overlay.getContext('2d');

  function onOrientation(e) {
    if (e.beta === null || e.gamma === null) return;
    const rad = Math.PI / 180;
    const deg = Math.acos(Math.min(1, Math.max(-1, Math.cos(e.beta * rad) * Math.cos(e.gamma * rad)))) / rad;
    state.tilt = { deg: deg, beta: e.beta, gamma: e.gamma, ts: Date.now() };
  }
  let orientationHooked = false;
  function hookOrientation() {
    if (orientationHooked || typeof DeviceOrientationEvent === 'undefined') return;
    const add = () => { window.addEventListener('deviceorientation', onOrientation); orientationHooked = true; };
    if (typeof DeviceOrientationEvent.requestPermission === 'function') {
      DeviceOrientationEvent.requestPermission().then((r) => { if (r === 'granted') add(); }).catch(() => {}); // iOS: needs the tap
    } else add();
  }
  const tiltFresh = () => !!state.tilt && Date.now() - state.tilt.ts < 3000;

  // "Nu s-a putut citi": the automatic scan did not manage to read the object. Records the attempt as "necitit".
  function notRead() {
    if (!state.auto.active || !video.videoWidth) return;
    const waited = Math.round((Date.now() - state.auto.startedAt) / 100) / 10;
    const lastMsg = $('autoStatus').textContent;
    noteWait(lastMsg);
    const waits = waitSnapshot();
    stopAuto();
    capture();                       // keep the frame the camera saw at this moment (no automatic reading)
    state.captureMeta.autoCapture = true;
    state.captureMeta.autoWaits = waits;
    state.captureMeta.autoWaitSec = waited;
    state.captureMeta.autoLastMessage = lastMsg;
    state.lastReading = { method: 'none', cls: 'necitit',
      reasons: ['citire automată nereușită după ' + String(waited).replace('.', ',') + ' s', 'ultimul mesaj: ' + lastMsg] };
    showResult();
    redraw();
    savePhoto();                     // downloaded to the phone, so it can be sent for analysis
    $('resultSection').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function savePhoto() {
    if (!state.frameCanvas) return;
    const id = ($('sampleId').value.trim() || 'fara-cod').replace(/[^A-Za-z0-9_-]+/g, '-');
    const tag = state.lastReading && state.lastReading.cls === 'necitit' ? '_necitit' : '';
    state.frameCanvas.toBlob((b) => { if (b) download('foto_' + state.product.id + '_' + id + tag + '_' + nowIso().slice(0, 19).replace(/[:T]/g, '-') + '.jpg', b, 'image/jpeg'); }, 'image/jpeg', 0.95);
  }

  function onCaptureClick() {
    if (state.auto.active) { stopAuto(); return; }
    if (!video.videoWidth) return;
    if (state.product.autoRegion && $('autoCapture').checked) startAuto();
    else capture();
  }

  function startAuto() {
    hookOrientation();
    state.auto.startedAt = Date.now(); $('btnNotRead').classList.remove('hidden');
    state.auto.waits = {}; state.auto.lastKey = null; state.auto.lastTickAt = Date.now(); state.auto.holdBreaks = 0; state.auto.ticks = 0; state.auto.detectMs = 0;
    state.auto.active = true; state.auto.last = null; state.auto.stable = 0; state.auto.notFoundSince = null; state.auto.lastExpStep = 0;
    $('btnCapture').textContent = 'Anulează';
    $('autoStatus').classList.remove('hidden');
    $('autoStatus').textContent = state.product.method === 'patches' ? 'Se caută cele trei triunghiuri…' : 'Se caută modelul cu dungi…';
    autoTick();
  }

  function stopAuto() {
    if (state.auto.timer) clearTimeout(state.auto.timer);
    state.auto.active = false; state.auto.timer = null;
    $('btnCapture').textContent = 'Fotografiază';
    $('btnNotRead').classList.add('hidden');
    $('autoStatus').classList.add('hidden');
    octxLive.clearRect(0, 0, overlay.width, overlay.height);
  }

  // After 5 s without finding the object, suggest that the wrong object may be selected
  function notFoundMsg(searching) {
    const a = state.auto, now = Date.now();
    if (!a.notFoundSince) a.notFoundSince = now;
    return now - a.notFoundSince >= 5000 ? 'Nu s-a găsit nimic. Asigurați-vă că ați selectat obiectul corect pentru scanare.' : searching;
  }

  // Overexposure: step the camera's exposure compensation down, where the phone exposes it
  function exposureComp() { const c = trackCaps().exposureCompensation; return c && typeof c === 'object' && 'min' in c ? c : null; }
  function lowerExposure() {
    const c = exposureComp(), a = state.auto;
    if (!c || !state.track) return false;
    if (Date.now() - a.lastExpStep < 700) return true;
    const cur = state.expComp !== null && state.expComp !== undefined ? state.expComp : (trackSettings().exposureCompensation || 0);
    const next = Math.max(c.min, cur - Math.max(c.step || 0, 0.5));
    if (next >= cur) return false; // already at the minimum
    a.lastExpStep = Date.now();
    state.expComp = next;
    state.track.applyConstraints({ advanced: [{ exposureCompensation: next }] }).catch(() => {});
    return true;
  }

  // ---- Wait diagnostics: how long each waiting message was on screen (seconds) ----
  const WAIT_KEYS = ['search', 'tooClose', 'tooFar', 'tilt', 'perspective', 'overexposed', 'glare', 'multiple', 'hold', 'other'];
  function waitKey(msg) {
    if (/^Se caută|^Nu s-a găsit nimic/.test(msg)) return 'search';
    if (/^Îndepărtați/.test(msg)) return 'tooClose';
    if (/^Apropiați/.test(msg)) return 'tooFar';
    if (/orizontală/.test(msg)) return 'tilt';
    if (/paralel/.test(msg)) return 'perspective';
    if (/^Prea multă lumină/.test(msg)) return 'overexposed';
    if (/^Reflexie/.test(msg)) return 'glare';
    if (/^Un singur indicator/.test(msg)) return 'multiple';
    if (/^Nu mișcați/.test(msg)) return 'hold';
    return 'other';
  }
  function noteWait(msg) { // time since the last tick goes to the message shown during it
    const a = state.auto, now = Date.now();
    if (a.lastKey) a.waits[a.lastKey] = (a.waits[a.lastKey] || 0) + (now - a.lastTickAt);
    a.lastKey = waitKey(msg); a.lastTickAt = now;
  }
  const WAIT_RO = { search: 'căutare', tooClose: 'prea aproape', tooFar: 'prea departe', tilt: 'înclinare', perspective: 'perspectivă',
    overexposed: 'prea multă lumină', glare: 'reflexie', multiple: 'mai multe obiecte', hold: 'nemișcare', other: 'altele' };
  function waitText(w) {
    const parts = WAIT_KEYS.filter((k) => w[k] > 0).map((k) => WAIT_RO[k] + ' ' + String(w[k]).replace('.', ',') + ' s');
    return (parts.join(' · ') || '—') + ' · nemișcare întreruptă de ' + w.holdBreaks + ' ori · ' + w.ticks + ' verificări, ' + w.detectMsAvg + ' ms/verificare';
  }
  function noteStable(prev) { if (prev > 0 && state.auto.stable === 0) state.auto.holdBreaks++; }
  function waitSnapshot() {
    const a = state.auto, o = {};
    WAIT_KEYS.forEach((k) => { o[k] = Math.round((a.waits[k] || 0) / 100) / 10; });
    o.holdBreaks = a.holdBreaks || 0;
    o.ticks = a.ticks || 0;
    o.detectMsAvg = a.ticks ? Math.round(a.detectMs / a.ticks) : '';
    return o;
  }

  function autoTick() {
    if (!state.auto.active) return;
    const a = state.auto, t = thr();
    const g = grabFrame(overlay.width, liveCanvas);
    if (state.product.method === 'patches') { autoTickPatches(g); return; }
    const t0 = performance.now();
    const d = D.detectPattern(g.image.data, g.image.width, g.image.height);
    a.ticks++; a.detectMs += performance.now() - t0;
    let msg = '', ok = false;
    octxLive.clearRect(0, 0, overlay.width, overlay.height);
    if (d.found) a.notFoundSince = null;
    if (!d.found) msg = notFoundMsg('Se caută modelul cu dungi…');
    else if (d.touchesBorder) msg = 'Îndepărtați telefonul: întregul model trebuie să fie în interiorul chenarului punctat';
    else if (d.areaFrac < t.minAreaFrac) msg = 'Apropiați telefonul';
    else if (t.useTiltSensor && tiltFresh() && state.tilt.deg > t.maxTiltDeg) msg = 'Țineți telefonul mai aproape de orizontală: ' + Math.round(state.tilt.deg) + '° (max. ' + t.maxTiltDeg + '°)';
    else if (d.sideRatio > t.maxSideRatio) msg = 'Țineți telefonul paralel cu testul';
    else ok = true;
    if (d.found) {
      octxLive.lineWidth = 3; octxLive.strokeStyle = ok ? '#00e676' : '#ffea00';
      octxLive.beginPath();
      d.corners.forEach((p, i) => (i ? octxLive.lineTo(p.x, p.y) : octxLive.moveTo(p.x, p.y)));
      octxLive.closePath(); octxLive.stroke();
    }
    if (ok) {
      const moved = a.last ? Math.max.apply(null, d.corners.map((p, i) => Math.hypot(p.x - a.last[i].x, p.y - a.last[i].y))) : Infinity;
      const prevStable = a.stable;
      a.stable = moved < 0.03 * g.image.width ? a.stable + 1 : 0;
      noteStable(prevStable);
      a.last = d.corners;
      msg = 'Nu mișcați telefonul…';
      if (a.stable >= 3) { noteWait(msg); const w = waitSnapshot(); stopAuto(); capture({ auto: true, waits: w }); return; }
    } else { if (a.stable > 0) a.holdBreaks++; a.stable = 0; a.last = null; }
    noteWait(msg);
    $('autoStatus').textContent = msg;
    a.timer = setTimeout(autoTick, 150);
  }

  // Live check for objects with separate indicator fields (triangles)
  function autoTickPatches(g) {
    const a = state.auto, t = thr();
    const t0 = performance.now();
    const d = D.detectStrip(g.image.data, g.image.width, g.image.height);
    a.ticks++; a.detectMs += performance.now() - t0;
    const toFull = video.videoWidth ? Math.min(video.videoWidth, video.videoHeight * CAPTURE_ASPECT) / g.image.width : 3;
    let msg = '', ok = false;
    octxLive.clearRect(0, 0, overlay.width, overlay.height);
    if (d.found) a.notFoundSince = null;
    const over = d.found && d.fields.some((p) => C.regionStats(g.image.data, g.image.width, g.image.height, p.x, p.y, Math.max(3, p.side * 0.3)).clippedFrac > t.maxClippedFrac);
    if (!d.found && d.reason === 'glare') { a.notFoundSince = null; msg = 'Reflexie pe etichetă: înclinați puțin telefonul sau mutați lumina'; }
    else if (!d.found) msg = notFoundMsg('Se caută eticheta indicatorului…');
    else if (d.multiple) msg = 'Un singur indicator în cadru, vă rog';
    else if (d.touchesBorder) msg = 'Îndepărtați telefonul: triunghiurile trebuie să fie în interiorul chenarului punctat';
    else if (d.fields[0].side * toFull * 0.3 < 8) msg = 'Apropiați telefonul: eticheta trebuie să ocupe cam jumătate din lățimea chenarului (acum ' + Math.round(d.labelFrac * 100) + '%)';
    else if (over) msg = lowerExposure() ? 'Prea multă lumină pe indicator: se reduce expunerea…' : 'Prea multă lumină pe indicator: umbriți-l ușor sau schimbați unghiul';
    else if (t.useTiltSensor && tiltFresh() && state.tilt.deg > t.maxTiltDeg) msg = 'Țineți telefonul mai aproape de orizontală: ' + Math.round(state.tilt.deg) + '° (max. ' + t.maxTiltDeg + '°)';
    else ok = true;
    if (d.found) {
      octxLive.lineWidth = 3; octxLive.strokeStyle = ok ? '#00e676' : '#ffea00';
      d.fields.forEach((p) => { octxLive.beginPath(); octxLive.arc(p.x, p.y, p.side * 0.6, 0, Math.PI * 2); octxLive.stroke(); });
      const b = d.band, c = Math.cos(b.ang) * b.len / 2, s = Math.sin(b.ang) * b.len / 2; // the title band the label was found by
      octxLive.beginPath(); octxLive.moveTo(b.cx - c, b.cy - s); octxLive.lineTo(b.cx + c, b.cy + s); octxLive.stroke();
    }
    if (ok) {
      const moved = a.last ? Math.max.apply(null, d.fields.map((p, i) => Math.hypot(p.x - a.last[i].x, p.y - a.last[i].y))) : Infinity;
      const prevStable = a.stable;
      a.stable = moved < 0.03 * g.image.width ? a.stable + 1 : 0;
      noteStable(prevStable);
      a.last = d.fields;
      msg = 'Nu mișcați telefonul…';
      if (a.stable >= 3) { noteWait(msg); const w = waitSnapshot(); stopAuto(); capture({ auto: true, waits: w }); return; }
    } else { if (a.stable > 0) a.holdBreaks++; a.stable = 0; a.last = null; }
    noteWait(msg);
    $('autoStatus').textContent = msg;
    a.timer = setTimeout(autoTick, 150);
  }

  // Automatic fields on the captured frame: find the three triangles and read them
  function autoPatches() {
    const f = state.frame;
    const d = D.detectStrip(f.data, f.width, f.height);
    state.patchPts = []; state.patchSize = null;
    if (!d.found || d.fields.length < thr().patches) {
      state.lastReading = null; $('resultSection').classList.add('hidden');
      state.autoNote = (d.reason === 'glare' ? 'Reflexie pe etichetă: triunghiurile nu au fost găsite automat. ' : 'Triunghiurile nu au fost găsite automat. ') + 'Atingeți fiecare triunghi; caseta se potrivește singură. '; redraw(); state.autoNote = '';
      return;
    }
    state.patchPts = d.fields.map((p) => ({ x: p.x, y: p.y }));
    state.patchSize = Math.max(6, Math.round(d.fields[0].side * 0.3)); // box well inside each triangle
    measurePatches();
    if (state.lastReading) {
      state.lastReading.autoFields = true;
      state.lastReading.reasons.push('triunghiuri selectate automat');
      if (d.multiple && state.lastReading.cls === 'pass') { state.lastReading.cls = 'uncertain'; state.lastReading.reasons.unshift('mai multe indicatoare în fotografie: lăsați doar unul în cadru'); }
      showResult();
    }
    redraw();
  }

  // Automatic region on the captured frame: find the pattern, straighten it, analyse it
  function autoRegion() {
    if (!state.frame || !state.product.autoRegion) return;
    if (state.product.method === 'patches') return autoPatches();
    const f = state.frame, t = thr();
    state.corners = [];
    const d = D.detectPattern(f.data, f.width, f.height);
    if (!d.found) {
      state.lastReading = null; $('resultSection').classList.add('hidden');
      state.autoNote = 'Modelul nu a fost găsit automat. '; redraw(); state.autoNote = '';
      return;
    }
    const rect = D.rectify(f.data, f.width, f.height, d.corners, 900);
    const r = C.analyseSheet(rect.data, rect.width, rect.height, { x0: 0, y0: 0, x1: rect.width, y1: rect.height }, t);
    if (r.error) { state.lastReading = null; showError(r.error); redraw(); return; }
    let cls = r.cls;
    const reasons = r.reasons.slice();
    if (cls === 'pass' && (d.aspect < t.aspectMin || d.aspect > t.aspectMax || d.touchesBorder)) {
      cls = 'uncertain';
      reasons.unshift(d.touchesBorder ? 'modelul atinge marginea fotografiei: este posibil să lipsească o parte din el'
        : 'zona detectată are o formă neașteptată (' + d.aspect.toFixed(2) + ' : 1): este posibil să lipsească o parte din model. Refaceți fotografia sau atingeți colțurile');
    }
    reasons.push('zonă selectată automat');
    state.lastReading = { method: 'sheet', cls: cls, reasons: reasons, sheet: r,
      auto: { corners: d.corners, aspect: d.aspect, sideRatio: d.sideRatio, areaFrac: d.areaFrac, angleDeg: d.angleDeg, map: rect.map, w: rect.width, h: rect.height } };
    showResult();
    redraw();
  }

  function resetRegions() {
    state.roiIndicator = null; state.roiWhite = null; state.corners = []; state.patchPts = []; state.patchSize = null; state.patchSizeManual = false; state.lastReading = null;
    $('resultSection').classList.add('hidden');
    redraw();
  }

  function roiPx() {
    if (!state.frame) return 20;
    return Math.max(4, Math.round((Math.min(state.frame.width, state.frame.height) * parseFloat($('roiSize').value)) / 100));
  }

  function redraw() {
    if (!state.frameCanvas) { $('stepText').textContent = ''; return; }
    ctx.drawImage(state.frameCanvas, 0, 0);
    const lw = Math.max(2, Math.round(frameCanvas.width / 300));
    const font = 'bold ' + Math.max(14, Math.round(frameCanvas.width / 40)) + 'px system-ui, sans-serif';
    const label = (text, x, y, colour) => {
      ctx.font = font; ctx.fillStyle = colour; ctx.strokeStyle = '#000'; ctx.lineWidth = Math.max(1, lw / 2);
      ctx.strokeText(text, x, y); ctx.fillText(text, x, y);
    };
    let step;
    if (state.product.method === 'patches') {
      const size = state.patchSize || roiPx(), need = thr().patches;
      const res = state.lastReading && state.lastReading.patches;
      const COL = { end: '#00c853', other: '#ff1744', unreadable: '#ff9100' };
      state.patchPts.forEach((p, i) => {
        const colour = res && res.res.patches[i] ? COL[res.res.patches[i].state] : '#00e5ff';
        ctx.lineWidth = lw; ctx.strokeStyle = colour;
        ctx.strokeRect(p.x - size / 2, p.y - size / 2, size, size);
        label(String(i + 1), p.x + size / 2 + 6, p.y, colour);
      });
      $('roiSizeVal').textContent = size + ' px';
      if (state.patchPts.length < need) step = (state.autoNote || '') + 'Atingeți triunghiul ' + (state.patchPts.length + 1) + ' din ' + need + ', în mijlocul lui. Caseta trebuie să rămână în interiorul triunghiului.';
      else step = (state.lastReading && state.lastReading.autoFields ? 'Triunghiuri selectate automat. ' : 'Gata. ') + 'Casete: verde = roz, roșu = nu este roz, portocaliu = nu s-a putut citi. Pentru selectare manuală, atingeți pe rând cele trei triunghiuri.';
    } else if (state.product.method === 'vial') {
      const size = roiPx();
      const drawBox = (p, colour, text) => {
        ctx.lineWidth = lw; ctx.strokeStyle = colour;
        ctx.strokeRect(p.x - size / 2, p.y - size / 2, size, size);
        label(text, p.x + size / 2 + 6, p.y, colour);
      };
      if (state.roiIndicator) drawBox(state.roiIndicator, '#00e5ff', 'LICHID');
      if (state.roiWhite && state.roiWhite !== 'skipped') drawBox(state.roiWhite, '#ffea00', 'ALB');
      $('roiSizeVal').textContent = size + ' px';
      if (!state.roiIndicator) step = 'Atingeți LICHIDUL din partea de jos a fiolei. Nu capacul: capacul este întotdeauna violet.';
      else if (!state.roiWhite) step = 'Atingeți zona ALBĂ a etichetei (referința de alb) sau omiteți acest pas.';
      else step = 'Gata. Atingeți din nou pentru a muta zona de pe lichid sau resetați selecția.';
      $('btnSkipWhite').disabled = !!state.roiWhite || !state.roiIndicator;
    } else {
      state.corners.forEach((p) => {
        ctx.fillStyle = '#00e5ff'; ctx.beginPath(); ctx.arc(p.x, p.y, lw * 4, 0, Math.PI * 2); ctx.fill();
      });
      const r = state.lastReading && state.lastReading.sheet;
      const au = state.lastReading && state.lastReading.auto;
      // cell boxes are in the straightened image for automatic regions: map them back onto the photo
      const toFrame = au ? (x, y) => au.map(x / au.w, y / au.h) : (x, y) => [x, y];
      const poly = (pts) => { ctx.beginPath(); pts.forEach((p, i) => (i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1]))); ctx.closePath(); ctx.stroke(); };
      if (au) { ctx.lineWidth = lw; ctx.strokeStyle = '#00e5ff'; poly(au.corners.map((p) => [p.x, p.y])); }
      if (state.corners.length === 2) {
        const [a, b] = state.corners;
        ctx.lineWidth = lw; ctx.strokeStyle = '#00e5ff';
        ctx.strokeRect(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.abs(a.x - b.x), Math.abs(a.y - b.y));
      }
      if (r && r.cells) {
        const t = thr();
        const typical = medianDensity(r);
        r.cells.forEach((c) => {
          let colour = '#00c853';
          if (c.pinkFrac === undefined) colour = '#9e9e9e';
          else if (c.pinkFrac > t.passCellPinkFrac) colour = '#ff1744';
          else if (c.medianL > t.passWorstCellL) colour = '#ff9100';
          if (colour !== '#ff1744' && c.inkDensity !== undefined && typical > 0 && c.inkDensity / typical < t.passInkRatio) colour = '#ff9100';
          ctx.lineWidth = Math.max(1, lw / 2); ctx.strokeStyle = colour;
          const k = au ? lw * au.w / Math.max(1, Math.hypot(au.corners[1].x - au.corners[0].x, au.corners[1].y - au.corners[0].y)) : lw;
          poly([toFrame(c.box[0] + k, c.box[1] + k), toFrame(c.box[2] - k, c.box[1] + k), toFrame(c.box[2] - k, c.box[3] - k), toFrame(c.box[0] + k, c.box[3] - k)]);
        });
      }
      const legend = 'Casete: verde = în regulă, roșu = a rămas roz, portocaliu = zonă mai deschisă / mai ștearsă, gri = prea puține dungi. ';
      if (au) step = 'Zonă selectată automat. ' + legend + 'Pentru selectare manuală, atingeți un colț al modelului.';
      else if (state.corners.length === 0) step = (state.autoNote || '') + 'Atingeți un COLȚ al modelului imprimat (de ex. stânga sus).';
      else if (state.corners.length === 1) step = 'Atingeți colțul OPUS al modelului imprimat.';
      else step = 'Gata. ' + legend + 'Atingeți imaginea pentru o nouă selecție.';
    }
    if (state.lastReading && state.lastReading.cls === 'necitit') step = 'Citire marcată ca „necitit”. Completați datele de mai jos și salvați în jurnal. Fotografia a fost descărcată pe telefon.';
    $('stepText').textContent = step;
  }

  function medianDensity(r) {
    const d = r.cells.filter((c) => c.inkDensity !== undefined).map((c) => c.inkDensity).sort((a, b) => a - b);
    return d.length ? d[Math.floor(d.length / 2)] : 0;
  }

  function onFrameTap(ev) {
    if (!state.frame) return;
    if (state.lastReading && state.lastReading.cls === 'necitit') { state.lastReading = null; $('resultSection').classList.add('hidden'); } // manual selection replaces it
    const rect = frameCanvas.getBoundingClientRect();
    const x = ((ev.clientX - rect.left) / rect.width) * frameCanvas.width;
    const y = ((ev.clientY - rect.top) / rect.height) * frameCanvas.height;
    if (state.product.method === 'patches') {
      if (state.patchPts.length >= thr().patches) { state.patchPts = []; state.patchSize = null; state.lastReading = null; $('resultSection').classList.add('hidden'); }
      // Fit the box to the tapped triangle (centre + size), unless the slider was moved by hand
      const fa = D.fieldAt(state.frame.data, state.frame.width, state.frame.height, { x: x, y: y });
      if (fa && !state.patchSizeManual) {
        state.patchPts.push({ x: fa.x, y: fa.y, fit: true });
        const sz = Math.max(6, Math.round(fa.side * 0.3));
        state.patchSize = state.patchSize ? Math.min(state.patchSize, sz) : sz;
      } else state.patchPts.push({ x: x, y: y });
      if (state.patchPts.length === thr().patches) measure();
      redraw();
    } else if (state.product.method === 'vial') {
      if (!state.roiIndicator || (state.roiIndicator && state.roiWhite)) state.roiIndicator = { x: x, y: y };
      else state.roiWhite = { x: x, y: y };
      redraw();
      if (state.roiIndicator && state.roiWhite) measure();
    } else {
      if (state.corners.length >= 2 || (state.lastReading && state.lastReading.auto)) { state.corners = []; state.lastReading = null; $('resultSection').classList.add('hidden'); }
      state.corners.push({ x: x, y: y });
      if (state.corners.length === 2) measure();
      redraw();
    }
  }

  // ======================================================================
  // Measurement
  // ======================================================================
  function refMeans(corrected) {
    const mean = (arr) => {
      const xs = arr.filter((r) => !!r.corrected === corrected);
      if (!xs.length) return null;
      const m = { L: 0, a: 0, b: 0 };
      xs.forEach((r) => { m.L += r.L; m.a += r.a; m.b += r.b; });
      return { L: m.L / xs.length, a: m.a / xs.length, b: m.b / xs.length, n: xs.length };
    };
    return { purple: mean(state.refs.purple), yellow: mean(state.refs.yellow) };
  }

  const VIAL_CLASS = { no_growth: 'pass', growth: 'fail', uncertain: 'uncertain' };

  function measurePatches() {
    const f = state.frame, size = state.patchSize || roiPx(), pts = state.patchPts;
    if (pts.length < thr().patches) return;
    // White reference = the label paper around the tapped fields
    const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y);
    const pad = Math.max(2 * size, 0.6 * Math.max(Math.max.apply(null, xs) - Math.min.apply(null, xs), Math.max.apply(null, ys) - Math.min.apply(null, ys)));
    const rect = { x0: Math.min.apply(null, xs) - pad, y0: Math.min.apply(null, ys) - pad, x1: Math.max.apply(null, xs) + pad, y1: Math.max.apply(null, ys) + pad };
    const white = C.paperWhite(f.data, f.width, f.height, rect);
    const fields = pts.map((p) => {
      const st = C.regionStats(f.data, f.width, f.height, p.x, p.y, size);
      if (!st.lin) return { stats: { clippedFrac: 1 }, lab: { L: 100, a: 0, b: 0 }, rawLab: null, raw: null };
      const corr = white ? C.applyWhiteReference(st.lin, white, 0.85) : st.lin;
      return { stats: st, lab: C.linRgbToLab(corr), rawLab: C.linRgbToLab(st.lin), raw: st.srgb, corr: corr };
    });
    const res = C.classifyPatches(fields, thr());
    state.lastReading = { method: 'patches', cls: res.cls, reasons: res.reasons.slice(), patches: { res, fields, white, roiSize: size } };
    showResult();
  }

  function measure() {
    if (state.product.method === 'patches') return measurePatches();
    if (state.product.method === 'sheet') return state.corners.length === 2 ? measureSheet() : autoRegion();
    const f = state.frame;
    const size = roiPx();
    const ind = C.regionStats(f.data, f.width, f.height, state.roiIndicator.x, state.roiIndicator.y, size);
    if (!ind.lin) { showError('Zona este complet saturată (reflexii). Mutați zona sau reduceți lumina.'); return; }
    const rawLab = C.linRgbToLab(ind.lin);
    let white = null, corrLin = null, corrLab = null, whiteWarn = '';
    if (state.roiWhite && state.roiWhite !== 'skipped') {
      white = C.regionStats(f.data, f.width, f.height, state.roiWhite.x, state.roiWhite.y, size);
      if (!white.lin) whiteWarn = 'Referința de alb este complet saturată: nu a fost folosită.';
      else {
        if (white.clippedFrac > 0.2) whiteWarn = 'Referința de alb este parțial saturată (' + Math.round(white.clippedFrac * 100) + '%): corecția este mai puțin sigură.';
        const wl = C.labToLch(C.linRgbToLab(white.lin));
        if (wl.C > 25) whiteWarn += (whiteWarn ? ' ' : '') + 'Referința de alb pare colorată (saturație ' + wl.C.toFixed(0) + '): ați atins partea albă a etichetei?';
        corrLin = C.applyWhiteReference(ind.lin, white.lin, 0.85);
        corrLab = C.linRgbToLab(corrLin);
      }
    }
    const corrected = !!corrLab;
    const labUsed = corrected ? corrLab : rawLab;
    const refs = refMeans(corrected);
    const res = C.classify(labUsed, ind, refs, thr());
    const reasons = res.reasons.slice();
    if (whiteWarn) reasons.push(whiteWarn);
    if (!corrected) reasons.push('fără referință de alb: s-au folosit culorile brute ale camerei');
    if (!refs.purple || !refs.yellow) reasons.push('calibrare incompletă pentru acest mod (' + (corrected ? 'cu' : 'fără') + ' referință de alb)');

    state.lastReading = {
      method: 'vial', cls: VIAL_CLASS[res.cls], reasons: reasons,
      vial: { ind, white, rawLab, corrLab, corrLin, corrected, labUsed, refs, res, whiteWarn, roiSize: size },
    };
    showResult();
  }

  function measureSheet() {
    const f = state.frame;
    const [a, b] = state.corners;
    const rect = { x0: Math.min(a.x, b.x), y0: Math.min(a.y, b.y), x1: Math.max(a.x, b.x), y1: Math.max(a.y, b.y) };
    const r = C.analyseSheet(f.data, f.width, f.height, rect, thr());
    if (r.error) { state.lastReading = null; showError(r.error); return; }
    state.lastReading = { method: 'sheet', cls: r.cls, reasons: r.reasons.slice(), sheet: r, rect: rect };
    showResult();
  }

  function swatch(rgb) {
    if (!rgb) return '';
    const c = rgb.map((v) => Math.round(Math.min(255, Math.max(0, v))));
    return '<span class="swatch" style="background:rgb(' + c.join(',') + ')"></span> ';
  }

  function showError(text) {
    $('resultSection').classList.remove('hidden');
    $('resultBox').className = 'result uncertain';
    $('resultBox').textContent = state.product.messages.uncertain;
    $('resultReasons').textContent = text;
    $('resultTable').innerHTML = '';
    $('btnSaveLog').disabled = true;
  }

  function showResult() {
    const r = state.lastReading;
    $('resultSection').classList.remove('hidden');
    $('btnSaveLog').disabled = false;
    const box = $('resultBox');
    box.className = 'result ' + { pass: 'no_growth', fail: 'growth', uncertain: 'uncertain', necitit: 'necitit' }[r.cls];
    box.textContent = r.cls === 'necitit' ? 'Necitit' : state.product.messages[r.cls];
    $('resultReasons').textContent = r.reasons.join(' · ');
    let rows;
    if (r.method === 'none') {
      rows = [['Fotografiere', 'automată, nereușită · timp de așteptare: ' + String(state.captureMeta.autoWaitSec).replace('.', ',') + ' s']];
    } else if (r.method === 'patches') {
      const P = r.patches, STATE_RO = { end: 'roz', other: 'nu este roz', unreadable: 'ilizibil' };
      rows = P.fields.map((fl, i) => {
        const p = P.res.patches[i];
        return ['Triunghiul ' + (i + 1), (fl.corr ? swatch(fl.corr.map(C.linearToSrgb)) : '') + STATE_RO[p.state] + (p.state === 'unreadable' ? ' (' + p.why + ')' : '') +
          ' · nuanță ' + fmt(p.lch.h, 0) + '° · saturație ' + fmt(p.lch.C) + ' · L* ' + fmt(p.lch.L, 0)];
      });
      rows.push(['Referință de alb (hârtia etichetei), RGB', P.white ? swatch(P.white.map(C.linearToSrgb)) + P.white.map((x) => fmt(C.linearToSrgb(x), 0)).join(', ') : 'negăsită']);
      rows.push(['Zonă', P.roiSize + ' px pe fiecare triunghi']);
    } else if (r.method === 'vial') {
      const v = r.vial;
      const lab = (l) => (l ? fmt(l.L) + ' / ' + fmt(l.a) + ' / ' + fmt(l.b) : '—');
      rows = [
        ['Lichid, RGB brut', swatch(v.ind.srgb) + v.ind.srgb.map((x) => fmt(x, 0)).join(', ')],
        ['Lichid, Lab brut', lab(v.rawLab)],
        ['Referință de alb, RGB', v.white && v.white.srgb ? swatch(v.white.srgb) + v.white.srgb.map((x) => fmt(x, 0)).join(', ') : 'nefolosită'],
        ['Lab corectat', v.corrLab ? swatch(v.corrLin.map(C.linearToSrgb)) + lab(v.corrLab) : '—'],
        ['Saturație / nuanță (valorile folosite)', fmt(v.res.lch.C) + ' / ' + fmt(v.res.lch.h, 0) + '°'],
        ['ΔE2000 față de referința violet', v.res.dePurple === null ? 'fără referință' : fmt(v.res.dePurple)],
        ['ΔE2000 față de referința galbenă', v.res.deYellow === null ? 'fără referință' : fmt(v.res.deYellow)],
        ['Uniformitatea zonei (σL*) / pixeli saturați', fmt(v.ind.spreadL) + ' / ' + Math.round(v.ind.clippedFrac * 100) + '%'],
        ['Zonă', v.roiSize + ' px, ' + v.ind.n + ' pixeli folosiți'],
      ];
    } else {
      const m = r.sheet.metrics;
      rows = [
        ['Hârtie (alb), RGB', swatch(m.paperLin.map(C.linearToSrgb)) + m.paperLin.map((x) => fmt(C.linearToSrgb(x), 0)).join(', ')],
        ['Pixeli de dungă', pct(m.inkFrac) + ' din zonă'],
        ['Proporția de roz din dungi (total / zona cea mai afectată)', pct(m.pinkFrac) + ' / ' + pct(m.maxCellPink)],
        ['Cât de închise sunt dungile, L* median (0 = negru)', fmt(m.medianInkL)],
        ['L* în zona cea mai închisă / cea mai deschisă', fmt(m.bestCellL) + ' / ' + fmt(m.worstCellL)],
        ['Diferența dintre zone (ΔL*)', fmt(m.spreadL)],
        ['Cea mai mică densitate a dungilor față de cea tipică', pct(m.minInkRatio)],
        ['Reflexii', pct(m.clippedFrac)],
        ['Zone analizate', m.cellsUsed + ' din ' + m.cellsTotal + ' (eșantionare la fiecare ' + m.step + ' px)'],
        ['Zonă', r.auto ? 'automată · formă ' + fmt(r.auto.aspect, 2) + ' : 1 · rotație ' + fmt(r.auto.angleDeg, 0) + '° · perspectivă ' + fmt(r.auto.sideRatio, 2) : 'manuală (două colțuri)'],
        ['Fotografiere', (state.captureMeta.autoCapture ? 'automată' : 'manuală') + (state.captureMeta.tiltDeg === null ? ' · fără date de la senzorul de înclinare' : ' · înclinarea telefonului: ' + fmt(state.captureMeta.tiltDeg, 0) + '°')],
      ];
    }
    if (state.captureMeta && state.captureMeta.autoWaits) rows.push(['Timp de așteptare', waitText(state.captureMeta.autoWaits)]);
    $('resultTable').innerHTML = rows.map((x) => '<tr><th>' + x[0] + '</th><td>' + x[1] + '</td></tr>').join('');
    $('saveStatus').textContent = '';
  }

  // ======================================================================
  // Log
  // ======================================================================
  function deviceInfo() {
    const uad = navigator.userAgentData;
    const brands = uad && uad.brands ? uad.brands.filter((b) => !/Not.?A.?Brand/i.test(b.brand)).map((b) => b.brand + ' ' + b.version).join('; ') : '';
    return {
      deviceLabel: $('deviceLabel').value.trim(),
      session: $('sessionCode').value.trim(),
      userAgent: navigator.userAgent,
      uaBrands: brands,
      uaPlatform: uad ? uad.platform : '',
      uaModel: (state.capReport.highEntropy && state.capReport.highEntropy.model) || '',
      uaPlatformVersion: (state.capReport.highEntropy && state.capReport.highEntropy.platformVersion) || '',
    };
  }

  function saveLog() {
    const r = state.lastReading;
    if (!r) return;
    if (!$('expected').value) { $('saveStatus').innerHTML = '<span class="warn">Selectați mai întâi rezultatul așteptat.</span>'; return; }
    if (!$('lighting').value) { $('saveStatus').innerHTML = '<span class="warn">Selectați mai întâi iluminarea.</span>'; return; }
    const s = state.captureMeta.settings || {};
    const expected = $('expected').value;
    const predicted = r.cls;
    const entry = Object.assign(
      { timestamp: nowIso(), build: BUILD, product: state.product.id },
      deviceInfo(),
      {
        cameraLabel: state.captureMeta.cameraLabel,
        cameraChoice: state.captureMeta.cameraChoice || '',
        autoCapture: state.captureMeta.autoCapture,
        autoWaitSec: state.captureMeta.autoWaitSec === null || state.captureMeta.autoWaitSec === undefined ? '' : state.captureMeta.autoWaitSec,
        autoLastMessage: state.captureMeta.autoLastMessage || '',
        ...(() => { // seconds spent under each waiting message, plus how often "hold still" restarted
          const w = state.captureMeta.autoWaits, o = {};
          WAIT_KEYS.forEach((k) => { o['wait_' + k] = w ? w[k] : ''; });
          o.holdBreaks = w ? w.holdBreaks : ''; o.liveChecks = w ? w.ticks : ''; o.detectMsAvg = w ? w.detectMsAvg : '';
          return o;
        })(),
        tiltDeg: state.captureMeta.tiltDeg === null ? '' : round(state.captureMeta.tiltDeg, 1),
        resolution: state.captureMeta.width + 'x' + state.captureMeta.height,
        videoResolution: state.captureMeta.videoWidth + 'x' + state.captureMeta.videoHeight,
        lockExposure: state.captureMeta.locks.exposure,
        lockWhiteBalance: state.captureMeta.locks.wb,
        lockFocus: state.captureMeta.locks.focus,
        torch: state.captureMeta.locks.torch,
        exposureMode: s.exposureMode || '', exposureTime: s.exposureTime ?? '', iso: s.iso ?? '', exposureCompensation: s.exposureCompensation ?? '',
        whiteBalanceMode: s.whiteBalanceMode || '', colorTemperature: s.colorTemperature ?? '',
        focusMode: s.focusMode || '', focusDistance: s.focusDistance ?? '',
      },
      r.method === 'none' ? {} : r.method === 'vial' ? vialFields(r.vial) : r.method === 'patches' ? patchFields(r.patches) : sheetFields(r),
      {
        predicted: predicted,
        message: predicted === 'necitit' ? 'Necitit' : state.product.messages[predicted],
        reasons: r.reasons.join(' | '),
        expected: expected,
        match: expected === 'unknown' ? '' : predicted === expected,
        unsafeError: expected === 'fail' && predicted === 'pass',
        lighting: $('lighting').value,
        angle: $('angle').value,
        phoneTilted: $('phoneTilted').checked,
        sampleId: $('sampleId').value.trim(),
        note: $('note').value.trim(),
        thresholds: JSON.stringify(thr()),
      }
    );
    state.log.push(entry);
    const ok = store.set(K.log, state.log);
    $('saveStatus').innerHTML = ok ? 'Salvat (nr. ' + state.log.length + ').' : '<span class="warn">Salvat doar cât timp pagina rămâne deschisă: stocarea în browser nu este disponibilă. Exportați înainte de a închide pagina.</span>';
    if (entry.unsafeError) $('saveStatus').innerHTML += ' <span class="warn">EROARE NESIGURĂ: o probă eșuată a fost citită ca trecută. Semnal de oprire, conform planului de test.</span>';
    renderLog();
    // Next reading of the series: placement 1 -> 2 -> ... -> 5 -> 1
    const pos = $('angle').value, n = parseInt(pos, 10);
    if (n >= 1 && n <= 5) { $('angle').selectedIndex = n % 5; saveSession(); }
  }

  function vialFields(v) {
    return {
      roiSizePx: v.roiSize,
      raw_r: round(v.ind.srgb[0], 1), raw_g: round(v.ind.srgb[1], 1), raw_b: round(v.ind.srgb[2], 1),
      raw_L: round(v.rawLab.L), raw_a: round(v.rawLab.a), raw_bstar: round(v.rawLab.b),
      whiteRefUsed: v.corrected,
      white_r: v.white && v.white.srgb ? round(v.white.srgb[0], 1) : '',
      white_g: v.white && v.white.srgb ? round(v.white.srgb[1], 1) : '',
      white_b: v.white && v.white.srgb ? round(v.white.srgb[2], 1) : '',
      whiteClippedPct: v.white ? Math.round(v.white.clippedFrac * 100) : '',
      corr_L: v.corrLab ? round(v.corrLab.L) : '', corr_a: v.corrLab ? round(v.corrLab.a) : '', corr_bstar: v.corrLab ? round(v.corrLab.b) : '',
      chroma: round(v.res.lch.C), hue: round(v.res.lch.h),
      spreadL: round(v.ind.spreadL), clippedPct: Math.round(v.ind.clippedFrac * 100),
      dE_purple: v.res.dePurple === null ? '' : round(v.res.dePurple),
      dE_yellow: v.res.deYellow === null ? '' : round(v.res.deYellow),
      refsPurpleN: v.refs.purple ? v.refs.purple.n : 0,
      refsYellowN: v.refs.yellow ? v.refs.yellow.n : 0,
    };
  }

  function patchFields(P) {
    const o = { roiSizePx: P.roiSize, patch_region: state.lastReading && state.lastReading.autoFields ? 'auto' : 'manual' };
    if (P.white) ['r', 'g', 'b'].forEach((ch, k) => { o['white_' + ch] = round(C.linearToSrgb(P.white[k]), 1); });
    P.fields.forEach((fl, i) => {
      const p = P.res.patches[i], n = 'patch' + (i + 1) + '_';
      o[n + 'state'] = p.state;
      o[n + 'hue'] = round(p.lch.h, 1); o[n + 'chroma'] = round(p.lch.C); o[n + 'L'] = round(p.lch.L);
      if (fl.raw) { o[n + 'raw_rgb'] = fl.raw.map((v) => Math.round(v)).join(' '); const rl = C.labToLch(fl.rawLab); o[n + 'raw_hue'] = round(rl.h, 1); o[n + 'raw_chroma'] = round(rl.C); }
      o[n + 'clippedPct'] = Math.round((fl.stats.clippedFrac || 0) * 100);
    });
    return o;
  }

  function sheetFields(r) {
    const m = r.sheet.metrics;
    return {
      sheet_region: r.auto ? 'auto' : 'manual',
      sheet_rect: r.auto ? r.auto.corners.map((p) => Math.round(p.x) + ' ' + Math.round(p.y)).join(' | ') : [r.rect.x0, r.rect.y0, r.rect.x1, r.rect.y1].map((v) => Math.round(v)).join(' '),
      sheet_aspect: r.auto ? round(r.auto.aspect) : '',
      sheet_sideRatio: r.auto ? round(r.auto.sideRatio) : '',
      sheet_rotationDeg: r.auto ? round(r.auto.angleDeg, 1) : '',
      sheet_areaPct: r.auto ? round(r.auto.areaFrac * 100, 1) : '',
      sheet_paper_r: round(C.linearToSrgb(m.paperLin[0]), 1), sheet_paper_g: round(C.linearToSrgb(m.paperLin[1]), 1), sheet_paper_b: round(C.linearToSrgb(m.paperLin[2]), 1),
      sheet_inkPct: round(m.inkFrac * 100, 1),
      sheet_pinkPct: round(m.pinkFrac * 100, 2),
      sheet_maxCellPinkPct: round(m.maxCellPink * 100, 2),
      sheet_medianInkL: round(m.medianInkL),
      sheet_spreadL: round(m.spreadL),
      sheet_bestCellL: round(m.bestCellL),
      sheet_worstCellL: round(m.worstCellL),
      sheet_minInkRatioPct: round(m.minInkRatio * 100, 1),
      sheet_glarePct: round(m.clippedFrac * 100, 1),
      sheet_cellsUsed: m.cellsUsed + '/' + m.cellsTotal,
    };
  }

  function renderLog() {
    const L = state.log;
    const judged = L.filter((e) => e.expected === 'pass' || e.expected === 'fail' || e.expected === 'no_growth' || e.expected === 'growth');
    const correct = judged.filter((e) => e.match === true).length;
    const unsafe = L.filter((e) => e.unsafeError).length;
    const unc = L.filter((e) => e.predicted === 'uncertain').length;
    const nr = L.filter((e) => e.predicted === 'necitit').length;
    $('logSummary').innerHTML = L.length + ' citiri · ' + correct + '/' + judged.length + ' corespund rezultatului așteptat · ' +
      unc + ' incerte · ' + nr + ' necitite · ' + (unsafe ? '<span class="warn">' + unsafe + ' NESIGURE</span>' : '0 nesigure');
    const last = L.slice(-10).reverse();
    $('logTable').innerHTML = last.length
      ? '<tr><th>Nr.</th><th>Ora</th><th>Obiect</th><th>Probă</th><th>Iluminare</th><th>Așteptat</th><th>Citit</th></tr>' +
        last.map((e, i) => '<tr><td>' + (L.length - i) + '</td><td>' + escapeHtml(e.timestamp.slice(11, 19)) + '</td><td>' +
          escapeHtml(e.product || 'bi-vial') + '</td><td>' + escapeHtml(e.sampleId) + '</td><td>' + escapeHtml(optionText('lighting', e.lighting)) + '</td><td>' +
          escapeHtml(CLS_RO[e.expected] || e.expected) + '</td><td>' + (e.unsafeError ? '<span class="warn">' : '') + escapeHtml(CLS_RO[e.predicted] || e.predicted) +
          (e.unsafeError ? '</span>' : '') + '</td></tr>').join('')
      : '<tr><td class="muted">Nicio citire salvată.</td></tr>';
  }

  function toCsv(rows) {
    if (!rows.length) return '';
    const cols = [];
    rows.forEach((r) => Object.keys(r).forEach((k) => { if (cols.indexOf(k) === -1) cols.push(k); }));
    const esc = (v) => {
      if (v === null || v === undefined) return '';
      const s = String(v);
      return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    };
    return '﻿' + cols.join(',') + '\r\n' + rows.map((r) => cols.map((c) => esc(r[c])).join(',')).join('\r\n') + '\r\n';
  }

  function download(name, text, mime) {
    const blob = text instanceof Blob ? text : new Blob([text], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }

  function fileStem() {
    const lbl = ($('deviceLabel').value.trim() || 'device').replace(/[^A-Za-z0-9_-]+/g, '-').slice(0, 30);
    return 'indicator-test_' + lbl + '_' + nowIso().slice(0, 16).replace(/[:T]/g, '-');
  }

  // Two-tap confirmation instead of a blocking dialog
  function armButton(btn, label, action) {
    if (btn.dataset.armed) {
      delete btn.dataset.armed; btn.textContent = label; action();
    } else {
      btn.dataset.armed = '1'; btn.textContent = 'Atingeți din nou pentru confirmare';
      setTimeout(() => { if (btn.dataset.armed) { delete btn.dataset.armed; btn.textContent = label; } }, 4000);
    }
  }

  // ======================================================================
  // Calibration references (vial)
  // ======================================================================
  function saveRef(kind) {
    const r = state.lastReading;
    if (!r || r.method !== 'vial') return;
    const l = r.vial.labUsed;
    state.refs[kind].push({ L: l.L, a: l.a, b: l.b, corrected: r.vial.corrected, timestamp: nowIso(), lighting: $('lighting').value, sampleId: $('sampleId').value.trim() });
    store.set(K.refs, state.refs);
    $('saveStatus').textContent = 'Salvat ca referință ' + REF_RO[kind] + ' (' + (r.vial.corrected ? 'cu' : 'fără') + ' referință de alb).';
    renderRefs();
  }

  function renderRefs() {
    const row = (kind, corrected) => {
      const xs = state.refs[kind].filter((r) => !!r.corrected === corrected);
      if (!xs.length) return '<tr><td>' + REF_RO[kind] + '</td><td>' + (corrected ? 'cu' : 'fără') + '</td><td>0</td><td>—</td><td>—</td></tr>';
      const m = refMeans(corrected)[kind];
      const spread = Math.max.apply(null, xs.map((x) => C.deltaE2000(x, m)));
      return '<tr><td>' + REF_RO[kind] + '</td><td>' + (corrected ? 'cu' : 'fără') + '</td><td>' + xs.length + '</td><td>' + swatch(labToApproxRgb(m)) +
        fmt(m.L) + ' / ' + fmt(m.a) + ' / ' + fmt(m.b) + '</td><td>' + fmt(spread) + '</td></tr>';
    };
    $('refTable').innerHTML = '<tr><th>Referință</th><th>Referință de alb</th><th>Citiri</th><th>Lab mediu</th><th>ΔE maxim față de medie</th></tr>' +
      row('purple', true) + row('yellow', true) + row('purple', false) + row('yellow', false);
  }

  // Lab -> sRGB, only for drawing swatches
  function labToApproxRgb(lab) {
    const fy = (lab.L + 16) / 116, fx = fy + lab.a / 500, fz = fy - lab.b / 200;
    const inv = (t) => (t * t * t > 216 / 24389 ? t * t * t : (116 * t - 16) / (24389 / 27));
    const X = inv(fx) * 0.95047, Y = inv(fy), Z = inv(fz) * 1.08883;
    const r = 3.2404542 * X - 1.5371385 * Y - 0.4985314 * Z;
    const g = -0.969266 * X + 1.8760108 * Y + 0.041556 * Z;
    const b = 0.0556434 * X - 0.2040259 * Y + 1.0572252 * Z;
    return [r, g, b].map(C.linearToSrgb);
  }

  // ======================================================================
  // Thresholds (per object)
  // ======================================================================
  const THR_LABELS = {
    // vial
    minChroma: 'Saturație minimă (mai cenușiu = incert)', minL: 'L* minim (mai întunecat = incert)', maxL: 'L* maxim (mai luminos = incert)',
    purpleHueMin: 'Nuanță violet de la (°)', purpleHueMax: 'Nuanță violet până la (°)',
    growthHueMin: 'Nuanță galben/verde de la (°)', growthHueMax: 'Nuanță galben/verde până la (°)',
    maxSpreadL: 'σL* maxim în zonă', maxClippedFrac: 'Proporție maximă de reflexii (0–1)',
    maxDePurple: 'Calibrat: ΔE maxim față de violet', marginDe: 'Calibrat: diferență minimă violet față de galben', maxDeYellow: 'Calibrat: ΔE maxim față de galben',
    // sheet
    insetFrac: 'Margine ignorată (0–0.2)', grid: 'Grilă (N × N zone)', inkDeltaL: 'Dungă = L* sub cel al hârtiei cu cel puțin',
    minInkFrac: 'Proporție minimă de dungi în zonă', minInkPerCell: 'Număr minim de pixeli de dungă pe zonă',
    pinkChroma: 'Roz: saturație minimă', pinkHueMin: 'Nuanță roz de la (°)', pinkHueMax: 'Nuanță roz până la (°)',
    passPinkFrac: 'Trecut: proporție maximă de roz (total)', passCellPinkFrac: 'Trecut: proporție maximă de roz (orice zonă)',
    passInkL: 'Trecut: L* median maxim al dungilor', passWorstCellL: 'Trecut: L* maxim în zona cea mai deschisă', passSpreadL: 'Trecut: ΔL* maxim între zone', passInkRatio: 'Trecut: raport minim al densității dungilor',
    failPinkFrac: 'Eșuat: proporție de roz (total) de la', failCellPinkFrac: 'Eșuat: proporție de roz (orice zonă) de la',
    maxTiltDeg: 'Fotografiere automată: înclinare maximă (°)', useTiltSensor: 'Fotografiere automată: folosește senzorul de mișcare (1/0)',
    maxSideRatio: 'Fotografiere automată: raport maxim între laturile opuse', minAreaFrac: 'Fotografiere automată: proporție minimă din cadru',
    aspectMin: 'Zonă automată: raport minim lățime/înălțime', aspectMax: 'Zonă automată: raport maxim lățime/înălțime',
    patches: 'Număr de triunghiuri (toate trebuie să fie roz)', passHueMin: 'Roz: nuanță de la (°)', passHueMax: 'Roz: nuanță până la (°)', passMinChroma: 'Roz: saturație minimă',
    failInkL: 'Eșuat: L* al dungilor de la', failSpreadL: 'Eșuat: ΔL* între zone de la (dacă zona cea mai deschisă nu este neagră)', failInkRatio: 'Eșuat: raportul densității dungilor sub',
  };
  function renderThresholds() {
    const t = thr();
    $('thresholdGrid').innerHTML = Object.keys(rulesOf(state.product)).map((k) =>
      '<label>' + (THR_LABELS[k] || k) + '<input type="number" step="any" data-thr="' + k + '" value="' + t[k] + '"></label>').join('');
  }
  function onThresholdChange(ev) {
    const k = ev.target.dataset.thr;
    if (!k) return;
    const v = parseFloat(ev.target.value);
    if (Number.isFinite(v)) {
      thr()[k] = v;
      store.set(K.thr, state.thresholds);
      if (state.lastReading) { measure(); redraw(); }
    }
  }

  // ======================================================================
  // Capability report
  // ======================================================================
  async function refreshCapabilities() {
    const rep = {
      generated: nowIso(), build: BUILD,
      userAgent: navigator.userAgent,
      secureContext: window.isSecureContext,
      getUserMedia: !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia),
      imageCaptureApi: 'ImageCapture' in window,
      barcodeDetectorApi: 'BarcodeDetector' in window,
      deviceOrientationApi: typeof DeviceOrientationEvent !== 'undefined',
      tiltSensorSeen: !!state.tilt,
      devicePixelRatio: window.devicePixelRatio,
      screen: screen.width + 'x' + screen.height,
    };
    try {
      if (navigator.userAgentData) {
        rep.uaData = { brands: navigator.userAgentData.brands, mobile: navigator.userAgentData.mobile, platform: navigator.userAgentData.platform };
        if (navigator.userAgentData.getHighEntropyValues) {
          rep.highEntropy = await navigator.userAgentData.getHighEntropyValues(['model', 'platformVersion', 'fullVersionList']);
        }
      }
    } catch (e) { rep.uaDataError = String(e); }
    try {
      if (rep.barcodeDetectorApi && BarcodeDetector.getSupportedFormats) rep.barcodeFormats = await BarcodeDetector.getSupportedFormats();
    } catch (e) { rep.barcodeError = String(e); }
    if (state.track) {
      rep.track = { label: state.track.label, settings: trackSettings(), capabilities: trackCaps() };
      const saved = store.get(K.cam, null); if (saved && saved.ranked) rep.cameras = saved.ranked;
      try { rep.track.constraints = state.track.getConstraints(); } catch (e) { /* ignore */ }
      if (state.imageCapture && state.imageCapture.getPhotoCapabilities) {
        try {
          const pc = await state.imageCapture.getPhotoCapabilities();
          rep.photoCapabilities = { redEyeReduction: pc.redEyeReduction, fillLightMode: pc.fillLightMode, imageHeight: pc.imageHeight, imageWidth: pc.imageWidth };
        } catch (e) { rep.photoCapabilitiesError = String(e); }
      }
    }
    try {
      if (navigator.mediaDevices && navigator.mediaDevices.enumerateDevices) {
        rep.videoInputs = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'videoinput').map((d) => d.label || '(label hidden until camera permission)');
      }
    } catch (e) { /* ignore */ }
    state.capReport = rep;
    $('capReport').textContent = JSON.stringify(rep, null, 2);
    renderCapSummary(rep);
  }

  function renderCapSummary(rep) {
    const caps = (rep.track && rep.track.capabilities) || {};
    const yn = (b) => (b ? 'da' : 'nu');
    const modes = (k) => (Array.isArray(caps[k]) ? caps[k].join(', ') : 'indisponibil');
    const range = (k) => (caps[k] && typeof caps[k] === 'object' && 'min' in caps[k] ? caps[k].min + '–' + caps[k].max : 'indisponibil');
    const rows = [
      ['Conexiune securizată (HTTPS)', yn(rep.secureContext)],
      ['Acces la cameră (getUserMedia)', yn(rep.getUserMedia)],
      ['Cameră pornită', rep.track ? 'da: ' + escapeHtml(rep.track.label || '') : 'nu (porniți camera)'],
      ['Camere spate testate (scor)', rep.cameras && rep.cameras.length ? rep.cameras.map((c) => escapeHtml(c.label || '?') + ': ' + c.score + ' (' + c.res + ', focalizare ' + escapeHtml(c.focus) + ', lanternă ' + (c.torch ? 'da' : 'nu') + ')').join('<br>') : 'o singură cameră sau încă netestate'],
      ['Mod de expunere', modes('exposureMode')],
      ['Interval pentru timpul de expunere', range('exposureTime')],
      ['Interval ISO', range('iso')],
      ['Compensarea expunerii', range('exposureCompensation')],
      ['Mod pentru balansul de alb', modes('whiteBalanceMode')],
      ['Interval pentru temperatura de culoare', range('colorTemperature')],
      ['Mod de focalizare', modes('focusMode')],
      ['Interval pentru distanța de focalizare', range('focusDistance')],
      ['Lanternă', 'torch' in caps ? 'da' : 'indisponibilă'],
      ['API ImageCapture', yn(rep.imageCaptureApi)],
      ['Senzor de înclinare (mișcare)', rep.tiltSensorSeen ? 'da, s-au primit date' : rep.deviceOrientationApi ? 'API disponibil, încă nu s-au primit date (faceți o fotografiere automată)' : 'nu'],
      ['Cititor de coduri (BarcodeDetector)', rep.barcodeDetectorApi ? 'da: ' + escapeHtml((rep.barcodeFormats || []).join(', ') || 'niciun format') : 'nu'],
      ['QR / DataMatrix', rep.barcodeFormats ? yn(rep.barcodeFormats.indexOf('qr_code') !== -1) + ' / ' + yn(rep.barcodeFormats.indexOf('data_matrix') !== -1) : '—'],
    ];
    $('capSummary').innerHTML = rows.map((r) => '<tr><th>' + r[0] + '</th><td>' + r[1] + '</td></tr>').join('');
  }

  // ======================================================================
  // Helpers + wiring
  // ======================================================================
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function saveSession() {
    store.set(K.session, { deviceLabel: $('deviceLabel').value, sessionCode: $('sessionCode').value, lighting: $('lighting').value, angle: $('angle').value, phoneTilted: $('phoneTilted').checked, product: state.product.id });
  }
  function loadSession() {
    const s = store.get(K.session, {});
    if (s.deviceLabel) $('deviceLabel').value = s.deviceLabel;
    if (s.sessionCode) $('sessionCode').value = s.sessionCode;
    if (s.lighting) $('lighting').value = s.lighting;
    if (s.angle) $('angle').value = s.angle;
    if ($('angle').selectedIndex < 0) $('angle').selectedIndex = 0; // value from an older build
    if (s.phoneTilted) $('phoneTilted').checked = true;
    return s.product;
  }

  $('selProduct').innerHTML = PRODUCTS.map((p) => '<option value="' + escapeHtml(p.id) + '">' + escapeHtml(p.label) + '</option>').join('');
  $('selProduct').addEventListener('change', (e) => setProduct(e.target.value));
  $('btnStart').addEventListener('click', () => { hookOrientation(); startCamera(); }); // sensor permission (iOS) needs the tap itself
  $('selCamera').addEventListener('change', (e) => startCamera(e.target.value));
  $('lockExposure').addEventListener('change', (e) => setLock('exposure', e.target.checked));
  $('lockWB').addEventListener('change', (e) => setLock('wb', e.target.checked));
  $('lockFocus').addEventListener('change', (e) => setLock('focus', e.target.checked));
  $('torch').addEventListener('change', (e) => setLock('torch', e.target.checked));
  $('btnCapture').addEventListener('click', onCaptureClick);
  $('autoCapture').addEventListener('change', (e) => { if (!e.target.checked) stopAuto(); else if (state.track && state.product.autoRegion && !state.auto.active) startAuto(); });
  $('btnAutoRoi').addEventListener('click', autoRegion);
  // Diagnostic photo: saved on the phone only, on request (never uploaded by the page)
  $('btnSavePhoto').addEventListener('click', savePhoto);
  $('btnNotRead').addEventListener('click', notRead);
  frameCanvas.addEventListener('click', onFrameTap);
  $('roiSize').addEventListener('input', () => {
    if (state.product.method === 'patches') { state.patchSize = null; state.patchSizeManual = true; if (state.patchPts.length === thr().patches) measure(); redraw(); return; }
    redraw(); if (state.roiIndicator && state.roiWhite) measure();
  });
  $('btnSkipWhite').addEventListener('click', () => { state.roiWhite = 'skipped'; redraw(); measure(); });
  $('btnResetRoi').addEventListener('click', resetRegions);
  $('btnRetake').addEventListener('click', () => {
    $('roiSection').classList.add('hidden'); $('resultSection').classList.add('hidden'); $('camSection').scrollIntoView({ behavior: 'smooth' });
    if (state.track && state.product.autoRegion && $('autoCapture').checked && !state.auto.active) startAuto();
  });
  $('btnSaveLog').addEventListener('click', saveLog);
  $('btnRefPurple').addEventListener('click', () => saveRef('purple'));
  $('btnRefYellow').addEventListener('click', () => saveRef('yellow'));
  $('btnClearRefs').addEventListener('click', (e) => armButton(e.target, 'Șterge referințele', () => {
    state.refs = { purple: [], yellow: [] }; store.set(K.refs, state.refs); renderRefs(); if (state.lastReading) measure();
  }));
  $('btnExportCsv').addEventListener('click', () => download(fileStem() + '.csv', toCsv(state.log), 'text/csv;charset=utf-8'));
  $('btnExportJson').addEventListener('click', () => download(fileStem() + '.json', JSON.stringify({
    exported: nowIso(), build: BUILD, capabilityReport: state.capReport, thresholds: state.thresholds, references: state.refs, log: state.log,
  }, null, 2), 'application/json'));
  $('btnClearLog').addEventListener('click', (e) => armButton(e.target, 'Șterge jurnalul', () => { state.log = []; store.set(K.log, state.log); renderLog(); }));
  $('thresholdGrid').addEventListener('change', onThresholdChange);
  $('btnResetThresholds').addEventListener('click', () => {
    state.thresholds[state.product.id] = Object.assign({}, rulesOf(state.product));
    store.set(K.thr, state.thresholds); renderThresholds(); if (state.lastReading) { measure(); redraw(); }
  });
  $('btnCapRefresh').addEventListener('click', refreshCapabilities);
  $('btnCapCopy').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(JSON.stringify(state.capReport, null, 2)); $('btnCapCopy').textContent = 'Copiat'; }
    catch (e) { $('btnCapCopy').textContent = 'Copierea nu a reușit: folosiți exportul'; }
    setTimeout(() => ($('btnCapCopy').textContent = 'Copiază'), 2500);
  });
  $('btnCapExport').addEventListener('click', () => download(fileStem() + '_capabilities.json', JSON.stringify(state.capReport, null, 2), 'application/json'));
  ['deviceLabel', 'sessionCode', 'lighting', 'angle', 'phoneTilted'].forEach((id) => $(id).addEventListener('change', saveSession));

  $('buildId').textContent = BUILD;
  const savedProduct = loadSession();
  setProduct(savedProduct || PRODUCTS[0].id);
  renderRefs();
  renderLog();
  refreshCapabilities();
})();
