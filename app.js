/* Indicator colour test: UI. Depends on colour.js (window.Colour) and products.js (window.PRODUCTS). No network calls. */
(function () {
  'use strict';
  const C = window.Colour;
  const PRODUCTS = window.PRODUCTS;
  const BUILD = '2026-11-19.3';
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
  const K = { log: 'bi-test-log', refs: 'bi-test-refs', thr: 'bi-test-thresholds-v2', thrOld: 'bi-test-thresholds', session: 'bi-test-session' };

  const DEFAULTS_BY_METHOD = { vial: C.DEFAULT_THRESHOLDS, sheet: C.SHEET_DEFAULTS };

  function loadThresholds() {
    const saved = store.get(K.thr, null) || {};
    const old = store.get(K.thrOld, null); // build .1 stored vial thresholds flat
    if (old && !saved['bi-vial']) saved['bi-vial'] = old;
    const out = {};
    PRODUCTS.forEach((p) => { out[p.id] = Object.assign({}, DEFAULTS_BY_METHOD[p.method], saved[p.id] || {}); });
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
    lastReading: null,
    capReport: {},
    log: store.get(K.log, []),
    refs: store.get(K.refs, { purple: [], yellow: [] }),
    thresholds: loadThresholds(),
    locks: { exposure: false, wb: false, focus: false, torch: false },
  };
  const thr = () => state.thresholds[state.product.id];

  const video = $('video');
  const frameCanvas = $('frame');
  const ctx = frameCanvas.getContext('2d', { willReadFrequently: true });

  const fmt = (v, d) => (v === null || v === undefined || Number.isNaN(v) ? '' : Number(v).toFixed(d === undefined ? 1 : d));
  const pct = (v) => (v === null || v === undefined ? '' : Math.round(v * 1000) / 10 + '%');
  const round = (v, d) => (v === null || v === undefined || v === '' ? '' : Number(Number(v).toFixed(d === undefined ? 2 : d)));
  const nowIso = () => new Date().toISOString();

  // ======================================================================
  // Object (product) selection
  // ======================================================================
  function setProduct(id) {
    state.product = PRODUCTS.find((p) => p.id === id) || PRODUCTS[0];
    $('selProduct').value = state.product.id;
    const vial = state.product.method === 'vial';
    $('productHint').textContent = vial
      ? 'Reads the liquid at the bottom of the vial. Optional white reference: the white part of the label.'
      : 'Reads the whole printed pattern of the sheet, area by area. Hold the phone parallel to the sheet; avoid shadows and reflections.';
    $('roiSizeRow').classList.toggle('hidden', !vial);
    $('btnSkipWhite').classList.toggle('hidden', !vial);
    $('calibBox').classList.toggle('hidden', !state.product.calibration);
    $('refSection').classList.toggle('hidden', !state.product.calibration);
    const exp = $('expected');
    exp.innerHTML = '<option value="">— select —</option>' +
      '<option value="pass">' + escapeHtml(state.product.expected.pass) + '</option>' +
      '<option value="fail">' + escapeHtml(state.product.expected.fail) + '</option>' +
      '<option value="unknown">Unknown</option>';
    resetRegions();
    renderThresholds();
    saveSession();
  }

  // ======================================================================
  // Camera
  // ======================================================================
  async function startCamera(deviceId) {
    const status = $('camStatus');
    if (!window.isSecureContext) { status.innerHTML = '<span class="warn">Not a secure context (HTTPS). The camera will not work.</span>'; return; }
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) { status.innerHTML = '<span class="warn">getUserMedia is not available in this browser.</span>'; return; }
    stopCamera();
    const video_c = deviceId
      ? { deviceId: { exact: deviceId }, width: { ideal: 1920 }, height: { ideal: 1080 } }
      : { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } };
    try {
      state.stream = await navigator.mediaDevices.getUserMedia({ video: video_c, audio: false });
    } catch (e) {
      status.innerHTML = '<span class="warn">Camera error: ' + escapeHtml(e.name + ' ' + e.message) + '</span>';
      return;
    }
    state.track = state.stream.getVideoTracks()[0];
    video.srcObject = state.stream;
    video.classList.remove('hidden');
    $('camControls').classList.remove('hidden');
    try { await video.play(); } catch (e) { /* ignore */ }
    await new Promise((res) => { if (video.videoWidth) res(); else video.onloadedmetadata = () => res(); });
    state.locks = { exposure: false, wb: false, focus: false, torch: false };
    ['lockExposure', 'lockWB', 'lockFocus', 'torch'].forEach((id) => ($(id).checked = false));
    try { state.imageCapture = 'ImageCapture' in window ? new ImageCapture(state.track) : null; } catch (e) { state.imageCapture = null; }
    status.textContent = 'Camera: ' + (state.track.label || 'unnamed') + ' · ' + video.videoWidth + '×' + video.videoHeight;
    $('btnStart').textContent = 'Restart camera';
    await listCameras();
    updateLockAvailability();
    await refreshCapabilities();
  }

  function stopCamera() {
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
    if ($('lockExposure').disabled) unsupported.push('exposure lock');
    if ($('lockWB').disabled) unsupported.push('white balance lock');
    if ($('lockFocus').disabled) unsupported.push('focus lock');
    if ($('torch').disabled) unsupported.push('torch');
    $('lockStatus').textContent = unsupported.length ? 'Not exposed by this phone/browser: ' + unsupported.join(', ') + '.' : 'All camera controls are exposed.';
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
      $('lockStatus').textContent = kind + (on ? ' locked/on' : ' auto/off') + ' · applied: ' + JSON.stringify(c);
    } catch (e) {
      state.locks[kind] = false;
      const box = { exposure: 'lockExposure', wb: 'lockWB', focus: 'lockFocus', torch: 'torch' }[kind];
      $(box).checked = false;
      $('lockStatus').innerHTML = '<span class="warn">Could not set ' + kind + ': ' + escapeHtml(e.name + ' ' + e.message) + '</span>';
    }
  }

  // ======================================================================
  // Capture + regions
  // ======================================================================
  function capture() {
    if (!video.videoWidth) return;
    const w = video.videoWidth, h = video.videoHeight;
    const off = document.createElement('canvas');
    off.width = w; off.height = h;
    const octx = off.getContext('2d', { willReadFrequently: true });
    octx.drawImage(video, 0, 0, w, h);
    state.frameCanvas = off;
    state.frame = octx.getImageData(0, 0, w, h);
    state.captureMeta = {
      settings: trackSettings(),
      locks: Object.assign({}, state.locks),
      width: w, height: h,
      cameraLabel: state.track ? state.track.label : '',
    };
    frameCanvas.width = w; frameCanvas.height = h;
    resetRegions();
    $('roiSection').classList.remove('hidden');
    $('roiSection').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function resetRegions() {
    state.roiIndicator = null; state.roiWhite = null; state.corners = []; state.lastReading = null;
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
    if (state.product.method === 'vial') {
      const size = roiPx();
      const drawBox = (p, colour, text) => {
        ctx.lineWidth = lw; ctx.strokeStyle = colour;
        ctx.strokeRect(p.x - size / 2, p.y - size / 2, size, size);
        label(text, p.x + size / 2 + 6, p.y, colour);
      };
      if (state.roiIndicator) drawBox(state.roiIndicator, '#00e5ff', 'LIQUID');
      if (state.roiWhite && state.roiWhite !== 'skipped') drawBox(state.roiWhite, '#ffea00', 'WHITE');
      $('roiSizeVal').textContent = size + ' px';
      if (!state.roiIndicator) step = 'Tap the LIQUID at the bottom of the vial. Not the cap: the cap is always purple.';
      else if (!state.roiWhite) step = 'Tap the WHITE area of the label (white reference), or skip.';
      else step = 'Done. Tap again to move the liquid region, or reset.';
      $('btnSkipWhite').disabled = !!state.roiWhite || !state.roiIndicator;
    } else {
      state.corners.forEach((p) => {
        ctx.fillStyle = '#00e5ff'; ctx.beginPath(); ctx.arc(p.x, p.y, lw * 4, 0, Math.PI * 2); ctx.fill();
      });
      const r = state.lastReading && state.lastReading.sheet;
      if (state.corners.length === 2) {
        const [a, b] = state.corners;
        ctx.lineWidth = lw; ctx.strokeStyle = '#00e5ff';
        ctx.strokeRect(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.abs(a.x - b.x), Math.abs(a.y - b.y));
      }
      if (r && r.cells) {
        const t = thr();
        const meds = r.cells.filter((x) => x.medianL !== undefined).map((x) => x.medianL);
        const darkest = meds.length ? Math.min.apply(null, meds) : 0;
        const typical = medianDensity(r);
        r.cells.forEach((c) => {
          let colour = '#00c853';
          if (c.pinkFrac === undefined) colour = '#9e9e9e';
          else if (c.pinkFrac > t.passCellPinkFrac) colour = '#ff1744';
          else if (c.medianL - darkest > t.passSpreadL) colour = '#ff9100';
          if (colour !== '#ff1744' && c.inkDensity !== undefined && typical > 0 && c.inkDensity / typical < t.passInkRatio) colour = '#ff9100';
          ctx.lineWidth = Math.max(1, lw / 2); ctx.strokeStyle = colour;
          ctx.strokeRect(c.box[0] + lw, c.box[1] + lw, c.box[2] - c.box[0] - 2 * lw, c.box[3] - c.box[1] - 2 * lw);
        });
      }
      if (state.corners.length === 0) step = 'Tap one CORNER of the printed pattern (e.g. top-left).';
      else if (state.corners.length === 1) step = 'Tap the OPPOSITE corner of the printed pattern.';
      else step = 'Done. Boxes: green = OK, red = pink left, orange = lighter / fainter area, grey = not enough stripes. Tap to start a new selection.';
    }
    $('stepText').textContent = step;
  }

  function medianDensity(r) {
    const d = r.cells.filter((c) => c.inkDensity !== undefined).map((c) => c.inkDensity).sort((a, b) => a - b);
    return d.length ? d[Math.floor(d.length / 2)] : 0;
  }

  function onFrameTap(ev) {
    if (!state.frame) return;
    const rect = frameCanvas.getBoundingClientRect();
    const x = ((ev.clientX - rect.left) / rect.width) * frameCanvas.width;
    const y = ((ev.clientY - rect.top) / rect.height) * frameCanvas.height;
    if (state.product.method === 'vial') {
      if (!state.roiIndicator || (state.roiIndicator && state.roiWhite)) state.roiIndicator = { x: x, y: y };
      else state.roiWhite = { x: x, y: y };
      redraw();
      if (state.roiIndicator && state.roiWhite) measure();
    } else {
      if (state.corners.length >= 2) { state.corners = []; state.lastReading = null; $('resultSection').classList.add('hidden'); }
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

  function measure() {
    if (state.product.method === 'sheet') return measureSheet();
    const f = state.frame;
    const size = roiPx();
    const ind = C.regionStats(f.data, f.width, f.height, state.roiIndicator.x, state.roiIndicator.y, size);
    if (!ind.lin) { showError('Region is fully saturated (glare). Move the region or reduce light.'); return; }
    const rawLab = C.linRgbToLab(ind.lin);
    let white = null, corrLin = null, corrLab = null, whiteWarn = '';
    if (state.roiWhite && state.roiWhite !== 'skipped') {
      white = C.regionStats(f.data, f.width, f.height, state.roiWhite.x, state.roiWhite.y, size);
      if (!white.lin) whiteWarn = 'White reference fully clipped: not used.';
      else {
        if (white.clippedFrac > 0.2) whiteWarn = 'White reference partly clipped (' + Math.round(white.clippedFrac * 100) + '%): correction less reliable.';
        const wl = C.labToLch(C.linRgbToLab(white.lin));
        if (wl.C > 25) whiteWarn += (whiteWarn ? ' ' : '') + 'White reference looks coloured (chroma ' + wl.C.toFixed(0) + '): did you tap the white label?';
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
    if (!corrected) reasons.push('no white reference: raw camera colours used');
    if (!refs.purple || !refs.yellow) reasons.push('not fully calibrated for this mode (' + (corrected ? 'with' : 'without') + ' white reference)');

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
    box.className = 'result ' + { pass: 'no_growth', fail: 'growth', uncertain: 'uncertain' }[r.cls];
    box.textContent = state.product.messages[r.cls];
    $('resultReasons').textContent = r.reasons.join(' · ');
    let rows;
    if (r.method === 'vial') {
      const v = r.vial;
      const lab = (l) => (l ? fmt(l.L) + ' / ' + fmt(l.a) + ' / ' + fmt(l.b) : '—');
      rows = [
        ['Liquid, raw RGB', swatch(v.ind.srgb) + v.ind.srgb.map((x) => fmt(x, 0)).join(', ')],
        ['Liquid, raw Lab', lab(v.rawLab)],
        ['White ref RGB', v.white && v.white.srgb ? swatch(v.white.srgb) + v.white.srgb.map((x) => fmt(x, 0)).join(', ') : 'not used'],
        ['Corrected Lab', v.corrLab ? swatch(v.corrLin.map(C.linearToSrgb)) + lab(v.corrLab) : '—'],
        ['Chroma / hue (used)', fmt(v.res.lch.C) + ' / ' + fmt(v.res.lch.h, 0) + '°'],
        ['ΔE2000 to purple ref', v.res.dePurple === null ? 'no reference' : fmt(v.res.dePurple)],
        ['ΔE2000 to yellow ref', v.res.deYellow === null ? 'no reference' : fmt(v.res.deYellow)],
        ['Region uniformity (σL*) / clipped', fmt(v.ind.spreadL) + ' / ' + Math.round(v.ind.clippedFrac * 100) + '%'],
        ['Region', v.roiSize + ' px, ' + v.ind.n + ' pixels used'],
      ];
    } else {
      const m = r.sheet.metrics;
      rows = [
        ['Paper (white) RGB', swatch(m.paperLin.map(C.linearToSrgb)) + m.paperLin.map((x) => fmt(C.linearToSrgb(x), 0)).join(', ')],
        ['Stripe pixels', pct(m.inkFrac) + ' of the area'],
        ['Pink share of stripes (whole / worst area)', pct(m.pinkFrac) + ' / ' + pct(m.maxCellPink)],
        ['Stripe darkness, median L* (0 = black)', fmt(m.medianInkL)],
        ['Darkness difference between areas (ΔL*)', fmt(m.spreadL)],
        ['Weakest stripe density vs typical', pct(m.minInkRatio)],
        ['Glare', pct(m.clippedFrac)],
        ['Areas analysed', m.cellsUsed + ' of ' + m.cellsTotal + ' (sampling every ' + m.step + ' px)'],
      ];
    }
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
    if (!$('expected').value) { $('saveStatus').innerHTML = '<span class="warn">Select the expected result first.</span>'; return; }
    if (!$('lighting').value) { $('saveStatus').innerHTML = '<span class="warn">Select the lighting first.</span>'; return; }
    const s = state.captureMeta.settings || {};
    const expected = $('expected').value;
    const predicted = r.cls;
    const entry = Object.assign(
      { timestamp: nowIso(), build: BUILD, product: state.product.id },
      deviceInfo(),
      {
        cameraLabel: state.captureMeta.cameraLabel,
        resolution: state.captureMeta.width + 'x' + state.captureMeta.height,
        lockExposure: state.captureMeta.locks.exposure,
        lockWhiteBalance: state.captureMeta.locks.wb,
        lockFocus: state.captureMeta.locks.focus,
        torch: state.captureMeta.locks.torch,
        exposureMode: s.exposureMode || '', exposureTime: s.exposureTime ?? '', iso: s.iso ?? '',
        whiteBalanceMode: s.whiteBalanceMode || '', colorTemperature: s.colorTemperature ?? '',
        focusMode: s.focusMode || '', focusDistance: s.focusDistance ?? '',
      },
      r.method === 'vial' ? vialFields(r.vial) : sheetFields(r),
      {
        predicted: predicted,
        message: state.product.messages[predicted],
        reasons: r.reasons.join(' | '),
        expected: expected,
        match: expected === 'unknown' ? '' : predicted === expected,
        unsafeError: expected === 'fail' && predicted === 'pass',
        lighting: $('lighting').value,
        angle: $('angle').value,
        sampleId: $('sampleId').value.trim(),
        note: $('note').value.trim(),
        thresholds: JSON.stringify(thr()),
      }
    );
    state.log.push(entry);
    const ok = store.set(K.log, state.log);
    $('saveStatus').innerHTML = ok ? 'Saved (#' + state.log.length + ').' : '<span class="warn">Saved for this page only: browser storage unavailable. Export before closing.</span>';
    if (entry.unsafeError) $('saveStatus').innerHTML += ' <span class="warn">UNSAFE ERROR: a failed sample was read as passed. Stop signal per test plan.</span>';
    renderLog();
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

  function sheetFields(r) {
    const m = r.sheet.metrics;
    return {
      sheet_rect: [r.rect.x0, r.rect.y0, r.rect.x1, r.rect.y1].map((v) => Math.round(v)).join(' '),
      sheet_paper_r: round(C.linearToSrgb(m.paperLin[0]), 1), sheet_paper_g: round(C.linearToSrgb(m.paperLin[1]), 1), sheet_paper_b: round(C.linearToSrgb(m.paperLin[2]), 1),
      sheet_inkPct: round(m.inkFrac * 100, 1),
      sheet_pinkPct: round(m.pinkFrac * 100, 2),
      sheet_maxCellPinkPct: round(m.maxCellPink * 100, 2),
      sheet_medianInkL: round(m.medianInkL),
      sheet_spreadL: round(m.spreadL),
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
    $('logSummary').innerHTML = L.length + ' captures · ' + correct + '/' + judged.length + ' match expected · ' +
      unc + ' uncertain · ' + (unsafe ? '<span class="warn">' + unsafe + ' UNSAFE</span>' : '0 unsafe');
    const last = L.slice(-10).reverse();
    $('logTable').innerHTML = last.length
      ? '<tr><th>#</th><th>Time</th><th>Object</th><th>Sample</th><th>Lighting</th><th>Expected</th><th>Predicted</th></tr>' +
        last.map((e, i) => '<tr><td>' + (L.length - i) + '</td><td>' + escapeHtml(e.timestamp.slice(11, 19)) + '</td><td>' +
          escapeHtml(e.product || 'bi-vial') + '</td><td>' + escapeHtml(e.sampleId) + '</td><td>' + escapeHtml(e.lighting) + '</td><td>' +
          escapeHtml(e.expected) + '</td><td>' + (e.unsafeError ? '<span class="warn">' : '') + escapeHtml(e.predicted) +
          (e.unsafeError ? '</span>' : '') + '</td></tr>').join('')
      : '<tr><td class="muted">No captures yet.</td></tr>';
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
    const blob = new Blob([text], { type: mime });
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
      btn.dataset.armed = '1'; btn.textContent = 'Tap again to confirm';
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
    $('saveStatus').textContent = 'Saved as ' + kind + ' reference (' + (r.vial.corrected ? 'with' : 'without') + ' white reference).';
    renderRefs();
  }

  function renderRefs() {
    const row = (kind, corrected) => {
      const xs = state.refs[kind].filter((r) => !!r.corrected === corrected);
      if (!xs.length) return '<tr><td>' + kind + '</td><td>' + (corrected ? 'with' : 'without') + '</td><td>0</td><td>—</td><td>—</td></tr>';
      const m = refMeans(corrected)[kind];
      const spread = Math.max.apply(null, xs.map((x) => C.deltaE2000(x, m)));
      return '<tr><td>' + kind + '</td><td>' + (corrected ? 'with' : 'without') + '</td><td>' + xs.length + '</td><td>' + swatch(labToApproxRgb(m)) +
        fmt(m.L) + ' / ' + fmt(m.a) + ' / ' + fmt(m.b) + '</td><td>' + fmt(spread) + '</td></tr>';
    };
    $('refTable').innerHTML = '<tr><th>Reference</th><th>White ref</th><th>Samples</th><th>Mean Lab</th><th>Max ΔE from mean</th></tr>' +
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
    minChroma: 'Min chroma (greyer = uncertain)', minL: 'Min L* (darker = uncertain)', maxL: 'Max L* (brighter = uncertain)',
    purpleHueMin: 'Purple hue from (°)', purpleHueMax: 'Purple hue to (°)',
    growthHueMin: 'Yellow/green hue from (°)', growthHueMax: 'Yellow/green hue to (°)',
    maxSpreadL: 'Max σL* in region', maxClippedFrac: 'Max glare share (0–1)',
    maxDePurple: 'Calibrated: max ΔE to purple', marginDe: 'Calibrated: min margin purple vs yellow', maxDeYellow: 'Calibrated: max ΔE to yellow',
    // sheet
    insetFrac: 'Ignore edge share (0–0.2)', grid: 'Grid (N × N areas)', inkDeltaL: 'Stripe = L* below paper by',
    minInkFrac: 'Min stripe share of area', minInkPerCell: 'Min stripe pixels per area',
    pinkChroma: 'Pink: min chroma', pinkHueMin: 'Pink hue from (°)', pinkHueMax: 'Pink hue to (°)',
    passPinkFrac: 'Pass: max pink share (whole)', passCellPinkFrac: 'Pass: max pink share (any area)',
    passInkL: 'Pass: max stripe L*', passSpreadL: 'Pass: max ΔL* between areas', passInkRatio: 'Pass: min stripe density ratio',
    failPinkFrac: 'Fail: pink share (whole) from', failCellPinkFrac: 'Fail: pink share (any area) from',
    failInkL: 'Fail: stripe L* from', failSpreadL: 'Fail: ΔL* between areas from', failInkRatio: 'Fail: stripe density ratio below',
  };
  function renderThresholds() {
    const t = thr();
    $('thresholdGrid').innerHTML = Object.keys(DEFAULTS_BY_METHOD[state.product.method]).map((k) =>
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
    const yn = (b) => (b ? 'yes' : 'no');
    const modes = (k) => (Array.isArray(caps[k]) ? caps[k].join(', ') : 'not exposed');
    const range = (k) => (caps[k] && typeof caps[k] === 'object' && 'min' in caps[k] ? caps[k].min + '–' + caps[k].max : 'not exposed');
    const rows = [
      ['Secure context (HTTPS)', yn(rep.secureContext)],
      ['getUserMedia', yn(rep.getUserMedia)],
      ['Camera running', rep.track ? 'yes: ' + escapeHtml(rep.track.label || '') : 'no (start the camera)'],
      ['Exposure mode', modes('exposureMode')],
      ['Exposure time range', range('exposureTime')],
      ['ISO range', range('iso')],
      ['White balance mode', modes('whiteBalanceMode')],
      ['Colour temperature range', range('colorTemperature')],
      ['Focus mode', modes('focusMode')],
      ['Focus distance range', range('focusDistance')],
      ['Torch', 'torch' in caps ? 'yes' : 'not exposed'],
      ['ImageCapture API', yn(rep.imageCaptureApi)],
      ['BarcodeDetector', rep.barcodeDetectorApi ? 'yes: ' + escapeHtml((rep.barcodeFormats || []).join(', ') || 'no formats') : 'no'],
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
    store.set(K.session, { deviceLabel: $('deviceLabel').value, sessionCode: $('sessionCode').value, lighting: $('lighting').value, angle: $('angle').value, product: state.product.id });
  }
  function loadSession() {
    const s = store.get(K.session, {});
    if (s.deviceLabel) $('deviceLabel').value = s.deviceLabel;
    if (s.sessionCode) $('sessionCode').value = s.sessionCode;
    if (s.lighting) $('lighting').value = s.lighting;
    if (s.angle) $('angle').value = s.angle;
    return s.product;
  }

  $('selProduct').innerHTML = PRODUCTS.map((p) => '<option value="' + escapeHtml(p.id) + '">' + escapeHtml(p.label) + '</option>').join('');
  $('selProduct').addEventListener('change', (e) => setProduct(e.target.value));
  $('btnStart').addEventListener('click', () => startCamera());
  $('selCamera').addEventListener('change', (e) => startCamera(e.target.value));
  $('lockExposure').addEventListener('change', (e) => setLock('exposure', e.target.checked));
  $('lockWB').addEventListener('change', (e) => setLock('wb', e.target.checked));
  $('lockFocus').addEventListener('change', (e) => setLock('focus', e.target.checked));
  $('torch').addEventListener('change', (e) => setLock('torch', e.target.checked));
  $('btnCapture').addEventListener('click', capture);
  frameCanvas.addEventListener('click', onFrameTap);
  $('roiSize').addEventListener('input', () => { redraw(); if (state.roiIndicator && state.roiWhite) measure(); });
  $('btnSkipWhite').addEventListener('click', () => { state.roiWhite = 'skipped'; redraw(); measure(); });
  $('btnResetRoi').addEventListener('click', resetRegions);
  $('btnRetake').addEventListener('click', () => { $('roiSection').classList.add('hidden'); $('resultSection').classList.add('hidden'); $('camSection').scrollIntoView({ behavior: 'smooth' }); });
  $('btnSaveLog').addEventListener('click', saveLog);
  $('btnRefPurple').addEventListener('click', () => saveRef('purple'));
  $('btnRefYellow').addEventListener('click', () => saveRef('yellow'));
  $('btnClearRefs').addEventListener('click', (e) => armButton(e.target, 'Clear references', () => {
    state.refs = { purple: [], yellow: [] }; store.set(K.refs, state.refs); renderRefs(); if (state.lastReading) measure();
  }));
  $('btnExportCsv').addEventListener('click', () => download(fileStem() + '.csv', toCsv(state.log), 'text/csv;charset=utf-8'));
  $('btnExportJson').addEventListener('click', () => download(fileStem() + '.json', JSON.stringify({
    exported: nowIso(), build: BUILD, capabilityReport: state.capReport, thresholds: state.thresholds, references: state.refs, log: state.log,
  }, null, 2), 'application/json'));
  $('btnClearLog').addEventListener('click', (e) => armButton(e.target, 'Clear log', () => { state.log = []; store.set(K.log, state.log); renderLog(); }));
  $('thresholdGrid').addEventListener('change', onThresholdChange);
  $('btnResetThresholds').addEventListener('click', () => {
    state.thresholds[state.product.id] = Object.assign({}, DEFAULTS_BY_METHOD[state.product.method]);
    store.set(K.thr, state.thresholds); renderThresholds(); if (state.lastReading) { measure(); redraw(); }
  });
  $('btnCapRefresh').addEventListener('click', refreshCapabilities);
  $('btnCapCopy').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(JSON.stringify(state.capReport, null, 2)); $('btnCapCopy').textContent = 'Copied'; }
    catch (e) { $('btnCapCopy').textContent = 'Copy failed: use Export'; }
    setTimeout(() => ($('btnCapCopy').textContent = 'Copy'), 2500);
  });
  $('btnCapExport').addEventListener('click', () => download(fileStem() + '_capabilities.json', JSON.stringify(state.capReport, null, 2), 'application/json'));
  ['deviceLabel', 'sessionCode', 'lighting', 'angle'].forEach((id) => $(id).addEventListener('change', saveSession));

  $('buildId').textContent = BUILD;
  const savedProduct = loadSession();
  setProduct(savedProduct || PRODUCTS[0].id);
  renderRefs();
  renderLog();
  refreshCapabilities();
})();
