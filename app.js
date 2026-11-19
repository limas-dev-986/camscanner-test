/* Indicator colour test: UI. Depends on colour.js (window.Colour). No network calls. */
(function () {
  'use strict';
  const C = window.Colour;
  const BUILD = '2026-11-19.1';
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
  const K = { log: 'bi-test-log', refs: 'bi-test-refs', thr: 'bi-test-thresholds', session: 'bi-test-session' };

  // ---------- state ----------
  const state = {
    stream: null,
    track: null,
    imageCapture: null,
    frame: null,          // ImageData of the captured frame
    frameCanvas: null,    // offscreen canvas with the clean frame
    roiIndicator: null,   // {x, y}
    roiWhite: null,       // {x, y} or 'skipped'
    lastReading: null,
    capReport: {},
    log: store.get(K.log, []),
    refs: store.get(K.refs, { purple: [], yellow: [] }),
    thresholds: Object.assign({}, C.DEFAULT_THRESHOLDS, store.get(K.thr, {})),
    locks: { exposure: false, wb: false, focus: false, torch: false },
  };

  const video = $('video');
  const frameCanvas = $('frame');
  const ctx = frameCanvas.getContext('2d', { willReadFrequently: true });

  const fmt = (v, d) => (v === null || v === undefined || Number.isNaN(v) ? '' : Number(v).toFixed(d === undefined ? 1 : d));
  const nowIso = () => new Date().toISOString();

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
    try { await video.play(); } catch (e) { /* autoplay may need the tap that started the camera; usually fine */ }
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
      const current = state.track && state.track.getSettings ? state.track.getSettings().deviceId : '';
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
    state.roiIndicator = null; state.roiWhite = null; state.lastReading = null;
    $('roiSection').classList.remove('hidden');
    $('resultSection').classList.add('hidden');
    redraw();
    $('roiSection').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function roiPx() {
    if (!state.frame) return 20;
    return Math.max(4, Math.round((Math.min(state.frame.width, state.frame.height) * parseFloat($('roiSize').value)) / 100));
  }

  function redraw() {
    if (!state.frameCanvas) return;
    ctx.drawImage(state.frameCanvas, 0, 0);
    const size = roiPx();
    const lw = Math.max(2, Math.round(frameCanvas.width / 300));
    const drawBox = (p, colour, label) => {
      ctx.lineWidth = lw; ctx.strokeStyle = colour;
      ctx.strokeRect(p.x - size / 2, p.y - size / 2, size, size);
      ctx.font = 'bold ' + Math.max(14, Math.round(frameCanvas.width / 40)) + 'px system-ui, sans-serif';
      ctx.fillStyle = colour; ctx.strokeStyle = '#000'; ctx.lineWidth = Math.max(1, lw / 2);
      ctx.strokeText(label, p.x + size / 2 + 6, p.y); ctx.fillText(label, p.x + size / 2 + 6, p.y);
    };
    if (state.roiIndicator) drawBox(state.roiIndicator, '#00e5ff', 'LIQUID');
    if (state.roiWhite && state.roiWhite !== 'skipped') drawBox(state.roiWhite, '#ffea00', 'WHITE');
    $('roiSizeVal').textContent = size + ' px';
    let step;
    if (!state.roiIndicator) step = 'Tap the LIQUID at the bottom of the vial. Not the cap: the cap is always purple.';
    else if (!state.roiWhite) step = 'Tap the WHITE area of the label (white reference), or skip.';
    else step = 'Done. Tap again to move the liquid region, or reset.';
    $('stepText').textContent = step;
    $('btnSkipWhite').disabled = !!state.roiWhite || !state.roiIndicator;
  }

  function onFrameTap(ev) {
    if (!state.frame) return;
    const rect = frameCanvas.getBoundingClientRect();
    const x = ((ev.clientX - rect.left) / rect.width) * frameCanvas.width;
    const y = ((ev.clientY - rect.top) / rect.height) * frameCanvas.height;
    if (!state.roiIndicator || (state.roiIndicator && state.roiWhite)) {
      state.roiIndicator = { x: x, y: y };
    } else {
      state.roiWhite = { x: x, y: y };
    }
    redraw();
    if (state.roiIndicator && state.roiWhite) measure();
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

  function measure() {
    const f = state.frame;
    const size = roiPx();
    const ind = C.regionStats(f.data, f.width, f.height, state.roiIndicator.x, state.roiIndicator.y, size);
    if (!ind.lin) {
      showResult(null, 'Region is fully saturated (glare). Move the region or reduce light.');
      return;
    }
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
    const res = C.classify(labUsed, ind, refs, state.thresholds);

    state.lastReading = {
      ind: ind, white: white, rawLab: rawLab, corrLab: corrLab, corrLin: corrLin, corrected: corrected,
      labUsed: labUsed, refs: refs, res: res, whiteWarn: whiteWarn, roiSize: size,
    };
    showResult(state.lastReading);
  }

  function swatch(rgb) {
    if (!rgb) return '';
    const c = rgb.map((v) => Math.round(Math.min(255, Math.max(0, v))));
    return '<span class="swatch" style="background:rgb(' + c.join(',') + ')"></span> ';
  }

  function showResult(r, errorText) {
    $('resultSection').classList.remove('hidden');
    const box = $('resultBox');
    if (!r) {
      box.className = 'result uncertain'; box.textContent = C.MESSAGES.uncertain;
      $('resultReasons').textContent = errorText || '';
      $('resultTable').innerHTML = '';
      return;
    }
    box.className = 'result ' + r.res.cls;
    box.textContent = C.MESSAGES[r.res.cls];
    const rs = r.res.reasons.slice();
    if (r.whiteWarn) rs.push(r.whiteWarn);
    if (!r.corrected) rs.push('no white reference: raw camera colours used');
    if (!r.refs.purple || !r.refs.yellow) rs.push('not fully calibrated for this mode (' + (r.corrected ? 'with' : 'without') + ' white reference)');
    $('resultReasons').textContent = rs.join(' · ');
    const lab = (l) => (l ? fmt(l.L) + ' / ' + fmt(l.a) + ' / ' + fmt(l.b) : '—');
    const rows = [
      ['Liquid, raw RGB', swatch(r.ind.srgb) + r.ind.srgb.map((v) => fmt(v, 0)).join(', ')],
      ['Liquid, raw Lab', lab(r.rawLab)],
      ['White ref RGB', r.white && r.white.srgb ? swatch(r.white.srgb) + r.white.srgb.map((v) => fmt(v, 0)).join(', ') : 'not used'],
      ['Corrected Lab', r.corrLab ? swatch(r.corrLin.map(C.linearToSrgb)) + lab(r.corrLab) : '—'],
      ['Chroma / hue (used)', fmt(r.res.lch.C) + ' / ' + fmt(r.res.lch.h, 0) + '°'],
      ['ΔE2000 to purple ref', r.res.dePurple === null ? 'no reference' : fmt(r.res.dePurple)],
      ['ΔE2000 to yellow ref', r.res.deYellow === null ? 'no reference' : fmt(r.res.deYellow)],
      ['Region uniformity (σL*) / clipped', fmt(r.ind.spreadL) + ' / ' + Math.round(r.ind.clippedFrac * 100) + '%'],
      ['Region', r.roiSize + ' px, ' + r.ind.n + ' pixels used'],
    ];
    $('resultTable').innerHTML = rows.map((x) => '<tr><th>' + x[0] + '</th><td>' + x[1] + '</td></tr>').join('');
    $('saveStatus').textContent = '';
  }

  // ======================================================================
  // Log
  // ======================================================================
  function deviceInfo() {
    const ua = navigator.userAgent;
    const uad = navigator.userAgentData;
    const brands = uad && uad.brands ? uad.brands.filter((b) => !/Not.?A.?Brand/i.test(b.brand)).map((b) => b.brand + ' ' + b.version).join('; ') : '';
    return {
      deviceLabel: $('deviceLabel').value.trim(),
      session: $('sessionCode').value.trim(),
      userAgent: ua,
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
    const predicted = r.res.cls;
    const entry = Object.assign(
      { timestamp: nowIso(), build: BUILD },
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
        roiSizePx: r.roiSize,
        raw_r: round(r.ind.srgb[0], 1), raw_g: round(r.ind.srgb[1], 1), raw_b: round(r.ind.srgb[2], 1),
        raw_L: round(r.rawLab.L), raw_a: round(r.rawLab.a), raw_bstar: round(r.rawLab.b),
        whiteRefUsed: r.corrected,
        white_r: r.white && r.white.srgb ? round(r.white.srgb[0], 1) : '',
        white_g: r.white && r.white.srgb ? round(r.white.srgb[1], 1) : '',
        white_b: r.white && r.white.srgb ? round(r.white.srgb[2], 1) : '',
        whiteClippedPct: r.white ? Math.round(r.white.clippedFrac * 100) : '',
        corr_L: r.corrLab ? round(r.corrLab.L) : '', corr_a: r.corrLab ? round(r.corrLab.a) : '', corr_bstar: r.corrLab ? round(r.corrLab.b) : '',
        chroma: round(r.res.lch.C), hue: round(r.res.lch.h),
        spreadL: round(r.ind.spreadL), clippedPct: Math.round(r.ind.clippedFrac * 100),
        dE_purple: r.res.dePurple === null ? '' : round(r.res.dePurple),
        dE_yellow: r.res.deYellow === null ? '' : round(r.res.deYellow),
        refsPurpleN: r.refs.purple ? r.refs.purple.n : 0,
        refsYellowN: r.refs.yellow ? r.refs.yellow.n : 0,
        predicted: predicted,
        message: C.MESSAGES[predicted],
        reasons: r.res.reasons.join(' | ') + (r.whiteWarn ? ' | ' + r.whiteWarn : ''),
        expected: expected,
        match: expected === 'unknown' ? '' : predicted === expected,
        unsafeError: expected === 'growth' && predicted === 'no_growth',
        lighting: $('lighting').value,
        angle: $('angle').value,
        sampleId: $('sampleId').value.trim(),
        note: $('note').value.trim(),
        thresholds: JSON.stringify(state.thresholds),
      }
    );
    state.log.push(entry);
    const ok = store.set(K.log, state.log);
    $('saveStatus').innerHTML = ok ? 'Saved (#' + state.log.length + ').' : '<span class="warn">Saved for this page only: browser storage unavailable. Export before closing.</span>';
    if (entry.unsafeError) $('saveStatus').innerHTML += ' <span class="warn">UNSAFE ERROR: growth read as no growth. Stop signal per test plan.</span>';
    renderLog();
  }

  const round = (v, d) => (v === null || v === undefined ? '' : Number(Number(v).toFixed(d === undefined ? 2 : d)));

  function renderLog() {
    const L = state.log;
    const judged = L.filter((e) => e.expected === 'no_growth' || e.expected === 'growth');
    const correct = judged.filter((e) => e.match === true).length;
    const unsafe = L.filter((e) => e.unsafeError).length;
    const unc = L.filter((e) => e.predicted === 'uncertain').length;
    $('logSummary').innerHTML = L.length + ' captures · ' + correct + '/' + judged.length + ' match expected · ' +
      unc + ' uncertain · ' + (unsafe ? '<span class="warn">' + unsafe + ' UNSAFE</span>' : '0 unsafe');
    const last = L.slice(-10).reverse();
    $('logTable').innerHTML = last.length
      ? '<tr><th>#</th><th>Time</th><th>Sample</th><th>Lighting</th><th>Expected</th><th>Predicted</th><th>Hue/C</th></tr>' +
        last.map((e, i) => '<tr><td>' + (L.length - i) + '</td><td>' + escapeHtml(e.timestamp.slice(11, 19)) + '</td><td>' +
          escapeHtml(e.sampleId) + '</td><td>' + escapeHtml(e.lighting) + '</td><td>' + escapeHtml(e.expected) + '</td><td>' +
          (e.unsafeError ? '<span class="warn">' : '') + escapeHtml(e.predicted) + (e.unsafeError ? '</span>' : '') + '</td><td>' +
          fmt(e.hue, 0) + '° / ' + fmt(e.chroma, 0) + '</td></tr>').join('')
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
    return 'bi-test_' + lbl + '_' + nowIso().slice(0, 16).replace(/[:T]/g, '-');
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
  // Calibration references
  // ======================================================================
  function saveRef(kind) {
    const r = state.lastReading;
    if (!r) return;
    const l = r.labUsed;
    state.refs[kind].push({ L: l.L, a: l.a, b: l.b, corrected: r.corrected, timestamp: nowIso(), lighting: $('lighting').value, sampleId: $('sampleId').value.trim() });
    store.set(K.refs, state.refs);
    $('saveStatus').textContent = 'Saved as ' + kind + ' reference (' + (r.corrected ? 'with' : 'without') + ' white reference).';
    renderRefs();
  }

  function renderRefs() {
    const row = (kind, corrected) => {
      const xs = state.refs[kind].filter((r) => !!r.corrected === corrected);
      if (!xs.length) return '<tr><td>' + kind + '</td><td>' + (corrected ? 'with' : 'without') + '</td><td>0</td><td>—</td><td>—</td></tr>';
      const m = refMeans(corrected)[kind];
      const spread = Math.max.apply(null, xs.map((x) => C.deltaE2000(x, m)));
      const rgb = labToApproxRgb(m);
      return '<tr><td>' + kind + '</td><td>' + (corrected ? 'with' : 'without') + '</td><td>' + xs.length + '</td><td>' + swatch(rgb) +
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
  // Thresholds
  // ======================================================================
  const THR_LABELS = {
    minChroma: 'Min chroma (greyer = uncertain)', minL: 'Min L* (darker = uncertain)', maxL: 'Max L* (brighter = uncertain)',
    purpleHueMin: 'Purple hue from (°)', purpleHueMax: 'Purple hue to (°)',
    growthHueMin: 'Yellow/green hue from (°)', growthHueMax: 'Yellow/green hue to (°)',
    maxSpreadL: 'Max σL* in region', maxClippedFrac: 'Max clipped share (0–1)',
    maxDePurple: 'Calibrated: max ΔE to purple', marginDe: 'Calibrated: min margin purple vs yellow', maxDeYellow: 'Calibrated: max ΔE to yellow',
  };
  function renderThresholds() {
    $('thresholdGrid').innerHTML = Object.keys(C.DEFAULT_THRESHOLDS).map((k) =>
      '<label>' + THR_LABELS[k] + '<input type="number" step="any" data-thr="' + k + '" value="' + state.thresholds[k] + '"></label>').join('');
  }
  function onThresholdChange(ev) {
    const k = ev.target.dataset.thr;
    if (!k) return;
    const v = parseFloat(ev.target.value);
    if (Number.isFinite(v)) {
      state.thresholds[k] = v;
      store.set(K.thr, state.thresholds);
      if (state.lastReading) measure();
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
      if (rep.barcodeDetectorApi && BarcodeDetector.getSupportedFormats) {
        rep.barcodeFormats = await BarcodeDetector.getSupportedFormats();
      }
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
    store.set(K.session, { deviceLabel: $('deviceLabel').value, sessionCode: $('sessionCode').value, lighting: $('lighting').value, angle: $('angle').value });
  }
  function loadSession() {
    const s = store.get(K.session, {});
    if (s.deviceLabel) $('deviceLabel').value = s.deviceLabel;
    if (s.sessionCode) $('sessionCode').value = s.sessionCode;
    if (s.lighting) $('lighting').value = s.lighting;
    if (s.angle) $('angle').value = s.angle;
  }

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
  $('btnResetRoi').addEventListener('click', () => { state.roiIndicator = null; state.roiWhite = null; state.lastReading = null; $('resultSection').classList.add('hidden'); redraw(); });
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
    state.thresholds = Object.assign({}, C.DEFAULT_THRESHOLDS); store.set(K.thr, state.thresholds); renderThresholds(); if (state.lastReading) measure();
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
  loadSession();
  renderThresholds();
  renderRefs();
  renderLog();
  refreshCapabilities();
})();
