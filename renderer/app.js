/**
 * app.js — Holla Renderer (runs in Electron's Chromium renderer process)
 *
 * Responsibilities:
 *   • Bootstrap Web Audio pipeline (getUserMedia → AudioWorklet)
 *   • Route AudioWorklet tap events → KNN classification → IPC action
 *   • Calibration wizard state machine
 *   • Render / update all UI
 *   • Persist profile changes via window.holla IPC bridge
 *
 * No bundler — vanilla ES2022 module-less script (loaded by index.html).
 */

'use strict';

// ── KNN Classifier (inline, no import/require in renderer) ────────────────
class KNNClassifier {
  constructor(k = 3) {
    this.k = k;
    this.samples = [];
    // Weights: [ild, sc, bandLow, bandMid, bandHigh, logEnergy]
    this.weights = [15, 4, 6, 5, 3, 0.3];
  }
  loadFromButtons(buttons) {
    this.samples = [];
    for (const btn of buttons) {
      for (const f of (btn.samples || [])) {
        this.samples.push({ buttonId: btn.id, name: btn.name, features: f });
      }
    }
  }
  addSample(buttonId, name, features) {
    this.samples.push({ buttonId, name, features });
  }
  clearButton(buttonId) {
    this.samples = this.samples.filter(s => s.buttonId !== buttonId);
  }
  _dist(a, b) {
    let s = 0;
    const len = Math.min(a.length, b.length, this.weights.length);
    for (let i = 0; i < len; i++) {
      const d = (a[i] - b[i]) * this.weights[i];
      s += d * d;
    }
    return Math.sqrt(s);
  }
  classify(features) {
    if (this.samples.length === 0) return null;
    const dists = this.samples.map(s => ({ ...s, dist: this._dist(features, s.features) }));
    dists.sort((a, b) => a.dist - b.dist);
    const k = Math.min(this.k, dists.length);
    const nbrs = dists.slice(0, k);
    const votes = {};
    for (const n of nbrs) votes[n.buttonId] = (votes[n.buttonId]||0) + 1;
    let max = 0, winnerId = null;
    for (const [id, c] of Object.entries(votes)) { if (c > max) { max=c; winnerId=id; } }
    const winner = nbrs.find(n => n.buttonId === winnerId);
    return { buttonId: winnerId, name: winner.name, confidence: max/k, distance: nbrs[0].dist };
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────
function uid() {
  return Math.random().toString(36).slice(2, 9) + Date.now().toString(36);
}
function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
function fmtTime(d) {
  return d.toLocaleTimeString('en-US', { hour12: false, hour:'2-digit', minute:'2-digit', second:'2-digit' });
}

// ── App State ─────────────────────────────────────────────────────────────
const state = {
  mode:        'idle',     // 'idle' | 'listening' | 'calibrating'
  buttons:     [],
  settings:    {},
  // Wizard
  wizard: {
    step:        1,
    name:        '',
    icon:        '🎯',
    actionType:  'open_url',
    actionValue: '',
    samples:     [],        // collected feature vectors
    editId:      null,      // non-null when editing an existing button
  },
  // Audio
  audioCtx:      null,
  workletNode:   null,
  analyserNode:  null,
  mediaStream:   null,
  isStereo:      false,
};

const knn       = new KNNClassifier(3);
const NEED_TAPS = 10;

const EMOJIS = [
  '🎯','📧','🎵','📸','💻','🌐','📁','⭐','🔔','🚀',
  '📺','🎮','💡','🔊','⏸️','⏭️','🔒','🖥️','📝','🛠️',
  '🔥','⚡','🌙','☀️','🎨','📊','🗂️','🤖','🎤','🔑',
];

const ACTION_HINTS = {
  open_url:       'Enter a URL to open in your default browser.',
  launch_app:     'Full path to the .exe or application (e.g. C:\\\\Windows\\\\notepad.exe).',
  screenshot:     'No value needed — a screenshot will be saved to your Desktop.',
  custom_command: 'Any shell command (runs via cmd.exe).',
};

// ── DOM references ────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);
const $$ = sel => document.querySelectorAll(sel);

// ── Initialise ────────────────────────────────────────────────────────────
async function init() {
  const profile = await window.holla.getProfile();
  state.buttons  = profile.buttons  || [];
  state.settings = profile.settings || {};
  knn.loadFromButtons(state.buttons);

  applySettingsToUI();
  renderButtonGrid();
  setupNav();
  setupTitlebar();
  setupWizard();
  setupSettingsPanel();
  setupListenButton();

  // Listen for toggle-listening from tray menu
  window.holla.onToggleListen(v => {
    if (v !== (state.mode === 'listening')) toggleListening();
  });
}

// ── Navigation ────────────────────────────────────────────────────────────
function setupNav() {
  $$('.nav-btn[data-view]').forEach(btn => {
    btn.addEventListener('click', () => {
      const view = btn.dataset.view;
      $$('.nav-btn[data-view]').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      $$('.view').forEach(v => v.classList.remove('active'));
      $(`view-${view}`).classList.add('active');
    });
  });
}

// ── Titlebar ──────────────────────────────────────────────────────────────
function setupTitlebar() {
  $('tb-minimize').addEventListener('click', () => window.holla.minimize());
  $('tb-maximize').addEventListener('click', () => window.holla.maximize());
  $('tb-close').addEventListener('click',    () => window.holla.close());
}

// ── Status indicator ──────────────────────────────────────────────────────
function setStatus(mode, text) {
  const dot  = $('status-dot');
  const txt  = $('status-text');
  dot.className  = `status-dot ${mode}`;
  txt.textContent = text;
}

// ── Listen Button ─────────────────────────────────────────────────────────
function setupListenButton() {
  $('btn-listen').addEventListener('click', toggleListening);
}

async function toggleListening() {
  if (state.mode === 'idle' || state.mode === 'calibrating') {
    await startAudio();
  } else {
    stopAudio();
  }
}

// ── Audio Pipeline ────────────────────────────────────────────────────────
async function startAudio() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount:     { ideal: 2 },
        echoCancellation: { ideal: false },
        noiseSuppression: { ideal: false },
        autoGainControl:  { ideal: false },
        latency:          { ideal: 0.01 },
        sampleRate:       { ideal: 48000 },
      }
    });

    const ctx = new AudioContext({ sampleRate: 48000 });
    await ctx.audioWorklet.addModule('../audio/audio-processor.js');

    const source    = ctx.createMediaStreamSource(stream);
    const analyser  = ctx.createAnalyser();
    analyser.fftSize = 2048;
    const worklet   = new AudioWorkletNode(ctx, 'holla-processor', {
      numberOfInputs: 1, numberOfOutputs: 0,
      channelCount:     2,
      channelCountMode: 'explicit',
    });

    // Configure worklet with current settings
    worklet.port.postMessage({ type: 'config',
      snrThreshold: state.settings.snrThreshold || 25,
      cooldown:     state.settings.cooldown     || 400,
      enabled:      true,
    });

    source.connect(analyser);
    source.connect(worklet);

    worklet.port.onmessage = ({ data }) => {
      if (data.type === 'tap')    onTapReceived(data);
      if (data.type === 'warmup') onWarmup(data);
    };

    state.audioCtx     = ctx;
    state.workletNode  = worklet;
    state.analyserNode = analyser;
    state.mediaStream  = stream;

    // Detect stereo
    const tracks   = stream.getAudioTracks();
    const settings = tracks[0]?.getSettings() || {};
    state.isStereo = (settings.channelCount || 1) >= 2;

    updateMicInfo(tracks[0]?.label || 'Unknown', ctx.sampleRate, state.isStereo);
    $('sr-badge').textContent = `${ctx.sampleRate} Hz`;

    if (!state.isStereo) {
      $('mono-badge').classList.remove('hidden');
      $('mono-badge').classList.add('warn');
    } else {
      $('mono-badge').classList.add('hidden');
    }

    // Start waveform
    startWaveform(analyser, ctx);

    // BUG FIX: Do NOT override 'calibrating' mode — user may have opened the
    // calibration wizard before clicking Start, so we must preserve that mode.
    if (state.mode !== 'calibrating') {
      state.mode = 'listening';
      setStatus('listening', 'Listening');
    } else {
      setStatus('calibrating', 'Calibrating…');
    }
    $('btn-listen').classList.add('active');
    $('listen-label').textContent = 'Stop';

  } catch (err) {
    console.error('[audio] start failed:', err);
    alert(`Microphone error: ${err.message}\n\nMake sure microphone access is allowed.`);
  }
}

function stopAudio() {
  if (state.workletNode) {
    state.workletNode.port.postMessage({ type: 'config', enabled: false });
    state.workletNode.disconnect();
    state.workletNode = null;
  }
  if (state.analyserNode) { state.analyserNode.disconnect(); state.analyserNode = null; }
  if (state.mediaStream)  { state.mediaStream.getTracks().forEach(t => t.stop()); state.mediaStream = null; }
  if (state.audioCtx)     { state.audioCtx.close(); state.audioCtx = null; }
  if (waveformRafId)      { cancelAnimationFrame(waveformRafId); waveformRafId = null; }

  state.mode = 'idle';
  setStatus('idle', 'Idle');
  $('btn-listen').classList.remove('active');
  $('listen-label').textContent = 'Start';

  // Clear waveform canvas
  const canvas = $('waveform-canvas');
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);
}

// ── Tap Handler ───────────────────────────────────────────────────────────
function onTapReceived({ features, monoMode, tdoa, snr, noiseFloor }) {
  // Always update SNR gauge
  updateSnrGauge(snr);

  // ── Absolute energy gate ─────────────────────────────────────────────
  // features[5] = logEnergy. log10(0.001) = -3.
  // Real taps are -3 or higher; ambient noise / phantom events are below -3.5.
  const logE = features[5];
  if (logE < -3.5) return;  // Too quiet — ignore completely

  if (state.mode === 'calibrating') {
    handleCalibrationTap(features, logE);
    return;
  }
  if (state.mode !== 'listening') return;
  if (state.buttons.length === 0)  return;

  // Classify
  const result = knn.classify(features);
  if (!result) return;

  const maxDist = state.settings.maxDistance || 300;

  // Find button definition first
  const btn = state.buttons.find(b => b.id === result.buttonId);
  if (!btn) return;

  if (result.distance <= maxDist) {
    updateMonitor(features, tdoa, result);
    addTapLog(fmtTime(new Date()), result, result.distance);
    fireButton(btn);
  } else {
    addTapLog(fmtTime(new Date()), null, result.distance);
  }
}


function fireButton(btn) {
  // Visual feedback
  const card = document.querySelector(`.button-card[data-id="${btn.id}"]`);
  if (card) {
    card.classList.remove('firing');
    void card.offsetWidth;  // reflow to restart animation
    card.classList.add('firing');
    setTimeout(() => card.classList.remove('firing'), 600);
  }

  // Ripple at random position (decorative)
  spawnRipple();

  // Execute action in main process
  window.holla.executeAction(btn.action);
  window.holla.tapFired(btn.name);

  addTapLogEntry(btn.name, 'fired');
}

// ── Waveform ──────────────────────────────────────────────────────────────
let waveformRafId = null;
function startWaveform(analyser, ctx) {
  const canvas = $('waveform-canvas');
  canvas.width  = canvas.offsetWidth * devicePixelRatio;
  canvas.height = 120 * devicePixelRatio;
  const c    = canvas.getContext('2d');
  const buf  = new Uint8Array(analyser.frequencyBinCount);

  function draw() {
    waveformRafId = requestAnimationFrame(draw);
    analyser.getByteTimeDomainData(buf);

    const W = canvas.width, H = canvas.height;
    c.clearRect(0, 0, W, H);

    // Background gradient
    const bg = c.createLinearGradient(0, 0, 0, H);
    bg.addColorStop(0, 'rgba(124,58,237,0.04)');
    bg.addColorStop(1, 'rgba(0,0,0,0)');
    c.fillStyle = bg;
    c.fillRect(0, 0, W, H);

    // Waveform
    c.beginPath();
    c.lineWidth   = 2 * devicePixelRatio;
    c.strokeStyle = '#7c3aed';
    const sliceW  = W / buf.length;
    let x = 0;
    for (let i = 0; i < buf.length; i++) {
      const y = (buf[i] / 128.0) * (H / 2);
      if (i === 0) c.moveTo(x, y); else c.lineTo(x, y);
      x += sliceW;
    }
    c.stroke();

    // Glow line at centre
    c.beginPath();
    c.strokeStyle = 'rgba(6,182,212,0.15)';
    c.lineWidth   = 1;
    c.moveTo(0, H/2); c.lineTo(W, H/2);
    c.stroke();
  }
  draw();
}

// ── Monitor panel updates ─────────────────────────────────────────────────
function updateMonitor(features, tdoa, result) {
  const ild = features[0];
  const logE = features[1];
  const bands = features.slice(2);

  // ILD bar: map −1…+1 → 0–100%
  const pct = ((ild + 1) / 2) * 100;
  $('tdoa-bar').style.left  = `${clamp(pct, 2, 98)}%`;
  $('tdoa-value').textContent = `ILD ${ild >= 0 ? '+' : ''}${ild.toFixed(3)}`;

  // 12-Band EQ (each 0–1)
  for (let i = 0; i < 12; i++) {
    const el = $(`eq-${i}`);
    if (el) el.style.height = `${(bands[i] * 100).toFixed(1)}%`;
  }

  // Feature table
  $('f-ild').textContent    = ild.toFixed(4);
  $('f-energy').textContent = logE.toFixed(4);

  if (result) {
    $('f-class').textContent = result.name;
    $('f-conf').textContent  = `${(result.confidence * 100).toFixed(0)}%`;
    $('f-dist').textContent  = result.distance.toFixed(2);
    const th = $('f-thresh');
    if (th) th.textContent = result.threshold ? result.threshold.toFixed(2) : '150';
  }
}

function updateSnrGauge(snr) {
  if (!snr) return;
  // Cap display at 80x
  const pct = Math.min(snr / 80 * 100, 100);
  $('snr-fill').style.width   = `${pct.toFixed(1)}%`;
  $('snr-val').textContent    = `${snr.toFixed(0)}×`;
  // Color: green if SNR > threshold, amber otherwise
  const threshold = state.settings.snrThreshold || 25;
  $('snr-fill').style.background = snr > threshold
    ? 'linear-gradient(90deg, var(--green), var(--cyan))'
    : 'linear-gradient(90deg, var(--amber), var(--red))';
}

function addTapLog(time, result, dist) {
  const log  = $('tap-log');
  const entry = document.createElement('div');
  entry.className = 'tap-log-entry';

  if (result && dist <= (state.settings.maxDistance||300)) {
    entry.innerHTML = `
      <span class="log-time">${time}</span>
      <span class="log-name">${result.name}</span>
      <span class="log-dist">d=${dist.toFixed(1)} · ${(result.confidence*100).toFixed(0)}%</span>`;
  } else {
    entry.innerHTML = `
      <span class="log-time">${time}</span>
      <span class="log-miss">No match (d=${dist?.toFixed(1)||'?'})</span>`;
  }

  log.insertBefore(entry, log.firstChild);
  while (log.children.length > 40) log.removeChild(log.lastChild);
}
// ── Warmup handler ───────────────────────────────────────────────────────
function onWarmup({ progress }) {
  if (state.mode !== 'calibrating') return;
  const pct = Math.round(progress * 100);
  $('cal-status').textContent = pct < 100
    ? `Calibrating microphone… ${pct}%`
    : 'Tap the table 10 times in the same spot!';
}

function addTapLogEntry(name, status) {
  addTapLog(fmtTime(new Date()), { name, confidence: 1 }, 0);
}

// ── Ripple effect ─────────────────────────────────────────────────────────
function spawnRipple() {
  const rc = $('ripple-container');
  const el = document.createElement('div');
  el.className = 'ripple';
  el.style.left = `${30 + Math.random() * 40}%`;
  el.style.top  = `${30 + Math.random() * 40}%`;
  rc.appendChild(el);
  setTimeout(() => el.remove(), 900);
}

// ── Mic info ──────────────────────────────────────────────────────────────
function updateMicInfo(name, sr, stereo) {
  $('mi-name').textContent     = name.length > 30 ? name.slice(0, 30)+'…' : name;
  $('mi-channels').textContent = stereo ? '2 (Stereo)' : '1 (Mono)';
  $('mi-sr').textContent       = `${sr} Hz`;
  $('mi-mode').textContent     = stereo ? 'TDOA + Spectral' : 'Spectral only';
}

// ── Settings Panel ────────────────────────────────────────────────────────
function applySettingsToUI() {
  const s = state.settings;
  setRange('s-snr',     's-snr-val',     s.snrThreshold || 25);
  setRange('s-cooldown','s-cooldown-val', s.cooldown     || 400);
  setRange('s-maxdist', 's-maxdist-val', s.maxDistance  || 300);
  setRange('s-k',       's-k-val',       s.k            || 3);
  $('s-notify').checked = s.notifyOnTap !== false;
}

function setRange(rangeId, valId, val) {
  const el = $(rangeId);
  if (!el) return;
  el.value = val;
  $(valId).textContent = val;
}

function setupSettingsPanel() {
  ['s-snr','s-cooldown','s-maxdist','s-k'].forEach(id => {
    $(id).addEventListener('input', () => {
      $(`${id}-val`).textContent = $(id).value;
    });
  });

  $('btn-save-settings').addEventListener('click', saveSettings);

  $('btn-test-mic').addEventListener('click', async () => {
    if (state.audioCtx) {
      $('btn-test-mic').textContent = 'Tap now!';
      setTimeout(() => { $('btn-test-mic').textContent = 'Test Microphone'; }, 2000);
    } else {
      await startAudio();
      // Switch to monitor view
      $$('.nav-btn[data-view]').forEach(b => b.classList.remove('active'));
      document.querySelector('[data-view="monitor"]').classList.add('active');
      $$('.view').forEach(v => v.classList.remove('active'));
      $('view-monitor').classList.add('active');
    }
  });
}

async function saveSettings() {
  const newSettings = {
    snrThreshold: parseInt($('s-snr').value),
    cooldown:     parseInt($('s-cooldown').value),
    maxDistance:  parseInt($('s-maxdist').value),
    k:            parseInt($('s-k').value),
    notifyOnTap:  $('s-notify').checked,
  };
  state.settings = { ...state.settings, ...newSettings };
  await window.holla.saveSettings(newSettings);

  knn.k = newSettings.k;

  // Push new config to running worklet
  if (state.workletNode) {
    state.workletNode.port.postMessage({ type: 'config',
      snrThreshold: newSettings.snrThreshold,
      cooldown:     newSettings.cooldown,
    });
  }

  const confirm = $('save-confirm');
  confirm.classList.remove('hidden');
  setTimeout(() => confirm.classList.add('hidden'), 2000);
}

// ── Button Grid ───────────────────────────────────────────────────────────
function renderButtonGrid() {
  const grid   = $('button-grid');
  const empty  = $('empty-state');
  const sub    = $('dash-sub');

  grid.innerHTML = '';

  if (state.buttons.length === 0) {
    empty.style.display = 'flex';
    grid.style.display  = 'none';
    sub.textContent = 'Click New Button to calibrate a tap zone and assign an action.';
    return;
  }

  empty.style.display = 'none';
  grid.style.display  = 'grid';
  sub.textContent = `${state.buttons.length} button${state.buttons.length !== 1 ? 's' : ''} calibrated. Tap your table!`;

  for (const btn of state.buttons) {
    const card = document.createElement('div');
    card.className     = 'button-card';
    card.dataset.id    = btn.id;
    card.style.setProperty('--card-color', btn.color || '#7c3aed');

    const actionLabel = btn.action.type === 'screenshot'
      ? 'Screenshot to Desktop'
      : btn.action.value || btn.action.type;

    const hasSamples = btn.samples && btn.samples.length >= NEED_TAPS;

    card.innerHTML = `
      <div class="card-menu">
        <button class="card-menu-btn edit-btn" title="Edit" data-id="${btn.id}">✎</button>
        <button class="card-menu-btn del-btn"  title="Delete" data-id="${btn.id}">✕</button>
      </div>
      <div class="card-icon">${btn.icon || '🎯'}</div>
      <div class="card-name">${btn.name}</div>
      <div class="card-action">${actionLabel}</div>
      <div class="card-badge ${hasSamples ? 'ok' : ''}">
        ${hasSamples ? '✓ Calibrated' : `${(btn.samples||[]).length}/${NEED_TAPS} taps`}
      </div>`;

    // Click = manual trigger (for testing)
    card.addEventListener('click', (e) => {
      if (e.target.closest('.card-menu')) return;
      fireButton(btn);
    });

    card.querySelector('.edit-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      openWizard(btn);
    });
    card.querySelector('.del-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      deleteButton(btn.id);
    });

    grid.appendChild(card);
  }
}

async function deleteButton(id) {
  if (!confirm('Delete this button?')) return;
  state.buttons = state.buttons.filter(b => b.id !== id);
  knn.clearButton(id);
  await window.holla.saveButtons(state.buttons);
  renderButtonGrid();
}

// ── Add Button button ─────────────────────────────────────────────────────
$('btn-add').addEventListener('click', () => openWizard(null));

// ── Calibration Wizard ────────────────────────────────────────────────────
function setupWizard() {
  // Populate emoji palette
  const palette = $('emoji-palette');
  for (const em of EMOJIS) {
    const btn = document.createElement('button');
    btn.className   = 'emoji-btn';
    btn.textContent = em;
    btn.addEventListener('click', () => {
      $$('.emoji-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      state.wizard.icon = em;
    });
    palette.appendChild(btn);
  }
  // Select first emoji by default
  palette.querySelector('.emoji-btn').classList.add('active');

  // Action type buttons
  $$('.action-type-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      $$('.action-type-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      state.wizard.actionType  = btn.dataset.type;
      updateActionValueUI();
    });
  });

  // Navigation buttons
  $('w-next-1').addEventListener('click', () => {
    const name = $('w-name').value.trim();
    if (!name) { $('w-name').focus(); $('w-name').classList.add('error'); return; }
    $('w-name').classList.remove('error');
    state.wizard.name = name;
    gotoWizardStep(2);
  });
  $('w-back-2').addEventListener('click', () => gotoWizardStep(1));
  $('w-next-2').addEventListener('click', () => {
    const type  = state.wizard.actionType;
    const value = $('w-action-value').value.trim();
    if (type !== 'screenshot' && !value) { $('w-action-value').focus(); return; }
    state.wizard.actionValue = value;
    gotoWizardStep(3);
    startCalibration();
  });
  $('w-back-3').addEventListener('click', () => {
    stopCalibration();
    gotoWizardStep(2);
  });
  $('w-finish').addEventListener('click', finishWizard);

  $('modal-close').addEventListener('click', closeWizard);
  $('modal-backdrop').addEventListener('click', (e) => {
    if (e.target === $('modal-backdrop')) closeWizard();
  });
}

function openWizard(existingBtn) {
  const w = state.wizard;
  w.step        = 1;
  w.samples     = [];
  w.editId      = existingBtn ? existingBtn.id : null;
  w.name        = existingBtn ? existingBtn.name  : '';
  w.icon        = existingBtn ? existingBtn.icon  : '🎯';
  w.actionType  = existingBtn ? existingBtn.action.type  : 'open_url';
  w.actionValue = existingBtn ? existingBtn.action.value : '';

  // Reset fields
  $('w-name').value = w.name;
  $$('.emoji-btn').forEach(b => {
    b.classList.toggle('active', b.textContent === w.icon);
  });
  $$('.action-type-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.type === w.actionType);
  });
  $('w-action-value').value = w.actionValue || '';
  updateActionValueUI();

  resetCalibrationUI();

  $('modal-title').textContent = existingBtn ? 'Edit Button' : 'New Button';
  $('modal-backdrop').classList.remove('hidden');
  gotoWizardStep(1);
}

function closeWizard() {
  stopCalibration();
  $('modal-backdrop').classList.add('hidden');
}

function gotoWizardStep(n) {
  state.wizard.step = n;
  $$('.wizard-step').forEach((el, i) => {
    el.classList.toggle('active', i === n - 1);
  });
  $$('.step-dot').forEach((dot, i) => {
    dot.classList.toggle('active', i === n - 1);
    dot.classList.toggle('done',   i < n - 1);
  });
}

function updateActionValueUI() {
  const type  = state.wizard.actionType;
  const wrap  = $('action-value-wrap');
  const input = $('w-action-value');
  const hint  = $('w-action-hint');

  wrap.style.display   = type === 'screenshot' ? 'none' : 'flex';
  hint.textContent     = ACTION_HINTS[type] || '';
  input.placeholder    = type === 'open_url' ? 'https://…' : (type === 'launch_app' ? 'C:\\\\...\\\\app.exe' : 'command here');
}

// ── Calibration (Step 3) ──────────────────────────────────────────────────
function startCalibration() {
  state.mode = 'calibrating';
  setStatus('calibrating', 'Calibrating…');
  resetCalibrationUI();

  if (!state.audioCtx) {
    // Audio not running yet — start it; mode stays 'calibrating'
    $('cal-status').textContent = 'Starting microphone…';
    startAudio();
  } else {
    // Audio already running — send RESET to worklet so warmup reruns
    // This fixes the "back then forward again" phantom tap bug
    if (state.workletNode) {
      state.workletNode.port.postMessage({ type: 'reset' });
    }
    $('cal-status').textContent = 'Calibrating microphone… 0%';
  }
}

function stopCalibration() {
  if (state.mode === 'calibrating') {
    state.mode = state.audioCtx ? 'listening' : 'idle';
    setStatus(state.mode === 'listening' ? 'listening' : 'idle',
              state.mode === 'listening' ? 'Listening' : 'Idle');
  }
}

function resetCalibrationUI() {
  state.wizard.samples = [];
  $('cal-count').textContent = '0';
  $('cal-progress').style.strokeDashoffset = '326.7';
  $('w-finish').classList.add('disabled');
  $('cal-status').textContent = 'Waiting for microphone…';
  $$('.sample-dot').forEach(d => d.classList.remove('filled'));
}

function handleCalibrationTap(features, logE) {
  const w = state.wizard;
  if (w.samples.length >= NEED_TAPS) return;

  // Reject if tap was too quiet (phantom event from noise floor glitch)
  if (logE === undefined) logE = features[5];
  if (logE < -3.5) {
    $('cal-status').textContent = 'Too quiet — tap harder on the table!';
    return;
  }

  w.samples.push(features);
  const n   = w.samples.length;
  const pct = n / NEED_TAPS;

  // Update ring
  $('cal-count').textContent = n;
  const circumference = 326.7;
  $('cal-progress').style.strokeDashoffset = circumference * (1 - pct);

  // Fill dot
  const dot = document.querySelector(`.sample-dot[data-idx="${n - 1}"]`);
  if (dot) dot.classList.add('filled');

  // Status
  if (n < NEED_TAPS) {
    $('cal-status').textContent = `Keep tapping... (${n}/10)`;
  } else {
    $('cal-status').textContent = 'Calibration complete!';
    $('w-finish').classList.remove('disabled');
  }

  // Ripple feedback
  spawnRipple();
}

async function finishWizard() {
  const w = state.wizard;
  if (w.samples.length < NEED_TAPS) return;

  const CARD_COLORS = [
    '#7c3aed','#2563eb','#059669','#d97706',
    '#dc2626','#7c3aed','#0891b2','#9333ea',
  ];
  const color = CARD_COLORS[state.buttons.length % CARD_COLORS.length];

  const button = {
    id:      w.editId || uid(),
    name:    w.name,
    icon:    w.icon,
    color,
    samples: w.samples,
    action: {
      type:  w.actionType,
      value: w.actionValue,
    }
  };

  if (w.editId) {
    // Replace existing button
    const idx = state.buttons.findIndex(b => b.id === w.editId);
    if (idx !== -1) state.buttons[idx] = button;
    knn.clearButton(w.editId);
  } else {
    state.buttons.push(button);
  }

  // Add calibration samples to KNN
  for (const f of button.samples) knn.addSample(button.id, button.name, f);

  await window.holla.saveButtons(state.buttons);
  closeWizard();
  stopCalibration();

  // Restore listening mode
  state.mode = state.audioCtx ? 'listening' : 'idle';
  setStatus(state.mode === 'listening' ? 'listening' : 'idle',
            state.mode === 'listening' ? 'Listening' : 'Idle');

  renderButtonGrid();

  // Switch to dashboard
  $$('.nav-btn[data-view]').forEach(b => b.classList.remove('active'));
  document.querySelector('[data-view="dashboard"]').classList.add('active');
  $$('.view').forEach(v => v.classList.remove('active'));
  $('view-dashboard').classList.add('active');
}

// ── Boot ──────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', init);
