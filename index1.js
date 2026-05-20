const API = 'http://127.0.0.1:8765';
const MIDI_MIN = 24;
const MIDI_MAX = 95;

const ui = {
  startPage: document.getElementById('startPage'),
  annotPage: document.getElementById('annotPage'),
  enterBtn: document.getElementById('enterBtn'),
  saveDirInput: document.getElementById('saveDirInput'),
  nextBtn: document.getElementById('nextBtn'),
  skipBtn: document.getElementById('skipBtn'),
  audio: document.getElementById('audio'),
  addSplitBtn: document.getElementById('addSplitBtn'),
  playheadLabel: document.getElementById('playheadLabel'),
  audioVol: document.getElementById('audioVol'),
  noteVol: document.getElementById('noteVol'),
  mixPlayBtn: document.getElementById('mixPlayBtn'),
  status: document.getElementById('status'),
  meta: document.getElementById('meta'),
  text: document.getElementById('text'),
  midi: document.getElementById('midi'),
  ruler: document.getElementById('ruler'),
  spec: document.getElementById('spec'),
  notes: document.getElementById('notes'),
  piano: document.getElementById('piano')
};

const state = {
  started: false,
  current: null,
  audioUrl: null,
  audioBuffer: null,
  notes: [],
  splitLines: [],
  selectedIds: new Set(),
  hoverId: null,
  activeSegmentIdx: 0,
  draggingSplitId: null,
  draggingPlayheadLine: false,
  statusBase: '未开始',
  statusTimer: null,
  audioVolume: 0.85,
  noteVolume: 0.35,
  mixTimer: null,
  mixTriggered: new Set(),
  mixEnabled: false,
  playheadAnimId: null,
  synthVoices: new Map(),
  synthSegmentIdx: -1,
  entering: false
};

let audioCtx = null;

function ensureAudioCtx() {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  return audioCtx;
}

function setStatus(msg) {
  state.statusBase = msg;
  ui.status.textContent = msg;
}

function updateMixButtonUi() {
  if (!ui.mixPlayBtn) return;
  ui.mixPlayBtn.textContent = state.mixEnabled ? '模式: 混合播放' : '模式: 仅原音频';
}

function applyMixVolumes() {
  ui.audio.volume = clamp(Number(state.audioVolume || 0), 0, 1);
}

async function refreshDownloadStatus() {
  if (!state.started) return;
  try {
    const data = await post('/status', {});
    const states = Object.values(data.worker_states || {});
    const summary = states.slice(0, 3).map((s) => s.phase).join(', ');
    const detail = states.find((s) => s.detail)?.detail || '';
    ui.status.textContent = `${state.statusBase} | 队列 ${data.queue_size}/${data.queue_max}${summary ? ` | 线程: ${summary}` : ''}${detail ? ` | ${detail}` : ''}`;
  } catch {
    ui.status.textContent = `${state.statusBase} | 状态获取失败`;
  }
}

function ensureStatusPolling() {
  if (state.statusTimer) return;
  state.statusTimer = setInterval(refreshDownloadStatus, 1000);
}

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

function midiToFreq(m) {
  return 440 * Math.pow(2, (m - 69) / 12);
}

function midiToName(m) {
  const names = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  const name = names[((m % 12) + 12) % 12];
  const octave = Math.floor(m / 12) - 1;
  return `${name}${octave}`;
}

function yToMidi(y, h) {
  const ratio = 1 - y / h;
  return Math.round(clamp(MIDI_MIN + ratio * (MIDI_MAX - MIDI_MIN), MIDI_MIN, MIDI_MAX));
}

function midiToY(m, h) {
  const ratio = (m - MIDI_MIN) / (MIDI_MAX - MIDI_MIN);
  return (1 - ratio) * h;
}

function tToX(t, dur, w) {
  return dur <= 0 ? 0 : (t / dur) * w;
}

function xToT(x, dur, w) {
  return w <= 0 ? 0 : (x / w) * dur;
}

function parseMidiInput(raw) {
  return String(raw || '')
    .split(',')
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n))
    .map((n) => clamp(Math.round(n), 0, 127));
}

function uid() {
  return `${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

function getAudioDuration() {
  return Math.max(0.001, ui.audio.duration || (state.current ? Number(state.current.duration || 10) : 10));
}

function getSegments() {
  const dur = getAudioDuration();
  const starts = [0, ...state.splitLines.map((s) => clamp(s.time, 0, dur)).sort((a, b) => a - b), dur];
  const out = [];
  for (let i = 0; i < starts.length - 1; i += 1) {
    const start = starts[i];
    const end = starts[i + 1];
    out.push({ idx: i, start, end });
  }
  return out;
}

function getSegmentIndexByTime(t) {
  const segs = getSegments();
  for (let i = 0; i < segs.length; i += 1) {
    if (t >= segs[i].start && t < segs[i].end) return segs[i].idx;
  }
  return Math.max(0, segs.length - 1);
}

function getPlayheadTime() {
  return clamp(Number(ui.audio.currentTime || 0), 0, getAudioDuration());
}

function setPlayheadTime(t) {
  const dur = getAudioDuration();
  ui.audio.currentTime = clamp(t, 0, dur);
}

function isValidChordText(raw) {
  const text = String(raw || '').trim();
  if (!text) return true;
  if (text === 'N') return true; // 没有和弦
  if (text === 'M') return true; // 多个和弦
  if (text === 'S') return true; // 微分和弦
  if (text === 'D') return true; // 仅分割任务
  if (text === 'C') return true; // 带有和弦标注
  const re = /^(C|C#|D|D#|E|F|F#|G|G#|A|A#|B):(maj|min|dom|dim|aug|N)(?:\/(C|C#|D|D#|E|F|F#|G|G#|A|A#|B))?$/;
  return re.test(text);
}

function syncMidiTextFromNotes() {
  const seq = state.notes
    .filter((n) => n.segmentIdx === state.activeSegmentIdx)
    .map((n) => n.midi)
    .sort((a, b) => a - b);
  ui.midi.value = seq.join(',');
}

function drawPiano() {
  const c = ui.piano;
  const ctx = c.getContext('2d');
  const w = c.width;
  const h = c.height;
  ctx.clearRect(0, 0, w, h);
  const pitchNames = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  for (let m = MIDI_MIN; m <= MIDI_MAX; m += 1) {
    const y1 = midiToY(m + 0.5, h);
    const y0 = midiToY(m - 0.5, h);
    const hh = y0 - y1;
    const black = [1, 3, 6, 8, 10].includes(m % 12);
    ctx.fillStyle = black ? '#1f2937' : '#f8fafc';
    ctx.fillRect(0, y1, w, hh);
    ctx.strokeStyle = '#cbd5e1';
    ctx.strokeRect(0, y1, w, hh);
    if (!black && m % 12 === 0) {
      const octave = Math.floor(m / 12) - 1;
      ctx.fillStyle = '#475569';
      ctx.font = '10px sans-serif';
      ctx.fillText(`${pitchNames[m % 12]}${octave}`, 4, y1 + 10);
    }
  }
}

function drawGrid() {
  const c = ui.notes;
  const ctx = c.getContext('2d');
  const w = c.width;
  const h = c.height;
  const dur = getAudioDuration();

  ctx.clearRect(0, 0, w, h);
  for (let m = MIDI_MIN; m <= MIDI_MAX; m += 1) {
    const y = midiToY(m, h);
    ctx.strokeStyle = 'rgba(148,163,184,0.35)';
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(w, y);
    ctx.stroke();
  }
  const step = 0.1;
  for (let t = 0; t <= dur + 1e-6; t += step) {
    const x = tToX(t, dur, w);
    ctx.strokeStyle = Math.round(t * 100) % 50 === 0 ? 'rgba(148,163,184,0.45)' : 'rgba(148,163,184,0.22)';
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, h);
    ctx.stroke();
  }
}

function drawRuler() {
  if (!ui.ruler) return;
  const c = ui.ruler;
  const ctx = c.getContext('2d');
  const w = c.width;
  const h = c.height;
  const dur = getAudioDuration();
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = '#f8fafc';
  ctx.fillRect(0, 0, w, h);
  const step = 0.5;
  for (let t = 0; t <= dur + 1e-6; t += step) {
    const x = tToX(t, dur, w);
    const major = Math.round(t * 10) % 10 === 0;
    ctx.strokeStyle = major ? '#64748b' : '#cbd5e1';
    ctx.beginPath();
    ctx.moveTo(x, major ? 9 : 14);
    ctx.lineTo(x, h);
    ctx.stroke();
    if (major) {
      ctx.fillStyle = '#475569';
      ctx.font = '11px sans-serif';
      ctx.fillText(`${t.toFixed(0)}s`, Math.min(w - 24, x + 2), 10);
    }
  }
  const playX = tToX(getPlayheadTime(), dur, w);
  ctx.strokeStyle = '#22c55e';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(playX, 0);
  ctx.lineTo(playX, h);
  ctx.stroke();
  ctx.lineWidth = 1;
}

function drawNotes() {
  drawGrid();
  const c = ui.notes;
  const ctx = c.getContext('2d');
  const w = c.width;
  const h = c.height;
  const nh = Math.max(5, h / (MIDI_MAX - MIDI_MIN + 1));
  state.notes.forEach((n) => {
    const segs = getSegments();
    const seg = segs[n.segmentIdx];
    if (!seg) return;
    const x0 = tToX(seg.start, getAudioDuration(), w);
    const x1 = tToX(seg.end, getAudioDuration(), w);
    const y = midiToY(n.midi, h);
    const selected = state.selectedIds.has(n.id);
    ctx.fillStyle = selected ? 'rgba(245,158,11,0.88)' : 'rgba(37,99,235,0.85)';
    ctx.fillRect(x0, y - nh * 0.5, Math.max(1, x1 - x0), nh);
    ctx.strokeStyle = selected ? '#b45309' : '#1d4ed8';
    ctx.strokeRect(x0, y - nh * 0.5, Math.max(1, x1 - x0), nh);
    if (state.hoverId === n.id) {
      const label = midiToName(n.midi);
      ctx.font = '12px sans-serif';
      const tw = ctx.measureText(label).width;
      const tx = Math.max(4, w - tw - 8);
      const ty = Math.max(12, y - nh * 0.5 - 4);
      ctx.fillStyle = 'rgba(15, 23, 42, 0.9)';
      ctx.fillRect(tx - 4, ty - 11, tw + 8, 14);
      ctx.fillStyle = '#f8fafc';
      ctx.fillText(label, tx, ty);
    }
  });

  const dur = getAudioDuration();
  state.splitLines.forEach((line) => {
    const x = tToX(line.time, dur, w);
    ctx.strokeStyle = '#ef4444';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, h);
    ctx.stroke();
    ctx.lineWidth = 1;
  });

  const playX = tToX(getPlayheadTime(), dur, w);
  ctx.strokeStyle = '#22c55e';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(playX, 0);
  ctx.lineTo(playX, h);
  ctx.stroke();
  ctx.lineWidth = 1;
}

function playPreview(midi, sec = 0.22) {
  const ctx = ensureAudioCtx();
  const now = ctx.currentTime;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = 'sine';
  osc.frequency.value = midiToFreq(midi);
  gain.gain.setValueAtTime(clamp(state.noteVolume, 0, 1), now);
  osc.connect(gain).connect(ctx.destination);
  osc.start(now);
  osc.stop(now + sec);
}

function startVoice(midi) {
  const ctx = ensureAudioCtx();
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = 'sine';
  osc.frequency.value = midiToFreq(midi);
  gain.gain.value = clamp(state.noteVolume, 0, 1);
  osc.connect(gain).connect(ctx.destination);
  osc.start();
  state.synthVoices.set(midi, { osc, gain });
}

function stopVoice(midi) {
  const v = state.synthVoices.get(midi);
  if (!v) return;
  try { v.osc.stop(); } catch {}
  try { v.osc.disconnect(); } catch {}
  try { v.gain.disconnect(); } catch {}
  state.synthVoices.delete(midi);
}

function stopAllVoices() {
  Array.from(state.synthVoices.keys()).forEach(stopVoice);
}

function syncSynthToPlayhead() {
  if (!state.mixEnabled || ui.audio.paused) {
    stopAllVoices();
    state.synthSegmentIdx = -1;
    return;
  }
  const segIdx = getSegmentIndexByTime(getPlayheadTime());
  if (segIdx === state.synthSegmentIdx) return;
  state.synthSegmentIdx = segIdx;
  const targetMidis = new Set(
    state.notes.filter((n) => n.segmentIdx === segIdx).map((n) => n.midi)
  );
  Array.from(state.synthVoices.keys()).forEach((m) => {
    if (!targetMidis.has(m)) stopVoice(m);
  });
  targetMidis.forEach((m) => {
    if (!state.synthVoices.has(m)) startVoice(m);
  });
}

function stopMixScheduler() {
  stopAllVoices();
  state.synthSegmentIdx = -1;
}

function stopPlayheadAnimation() {
  if (state.playheadAnimId !== null) {
    cancelAnimationFrame(state.playheadAnimId);
    state.playheadAnimId = null;
  }
}

function startPlayheadAnimation() {
  stopPlayheadAnimation();
  const tick = () => {
    if (!ui.audio.paused && !ui.audio.ended && !state.draggingPlayheadLine) {
      updatePlayheadUi();
      state.playheadAnimId = requestAnimationFrame(tick);
    } else {
      state.playheadAnimId = null;
    }
  };
  state.playheadAnimId = requestAnimationFrame(tick);
}

function computeSpecAndDraw(buffer) {
  const c = ui.spec;
  const ctx = c.getContext('2d');
  const w = c.width;
  const h = c.height;
  ctx.clearRect(0, 0, w, h);
  const data = buffer.getChannelData(0);
  const sr = buffer.sampleRate;
  const win = 1024;
  const hop = 128;
  const frames = Math.max(1, Math.floor((data.length - win) / hop));

  for (let x = 0; x < w; x += 1) {
    const fi = Math.floor((x / w) * frames);
    const off = fi * hop;
    for (let m = MIDI_MIN; m <= MIDI_MAX; m += 1) {
      const freq = midiToFreq(m);
      const k = 2 * Math.PI * freq / sr;
      let re = 0;
      let im = 0;
      for (let n = 0; n < win; n += 1) {
        const s = data[Math.min(data.length - 1, off + n)] || 0;
        const wv = 0.5 - 0.5 * Math.cos((2 * Math.PI * n) / (win - 1));
        const ang = k * n;
        re += s * wv * Math.cos(ang);
        im -= s * wv * Math.sin(ang);
      }
      const mag = Math.log1p(Math.sqrt(re * re + im * im));
      const v = clamp(mag / 5, 0, 1);
      const y = midiToY(m, h);
      const hh = h / (MIDI_MAX - MIDI_MIN + 1);
      const r = Math.floor(10 + 90 * v);
      const g = Math.floor(20 + 120 * v);
      const b = Math.floor(30 + 230 * v);
      ctx.fillStyle = `rgb(${r},${g},${b})`;
      ctx.fillRect(x, y - hh * 0.5, 1, hh + 1);
    }
  }
}

async function post(path, payload = {}) {
  const resp = await fetch(`${API}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok || data.ok === false) throw new Error(data.error || '请求失败');
  return data;
}

async function decodeLoadedAudio(blob) {
  const ab = await blob.arrayBuffer();
  const ctx = ensureAudioCtx();
  state.audioBuffer = await ctx.decodeAudioData(ab.slice(0));
  computeSpecAndDraw(state.audioBuffer);
  drawNotes();
}

function updatePlayheadUi() {
  const dur = getAudioDuration();
  const t = getPlayheadTime();
  if (ui.playheadLabel) {
    ui.playheadLabel.textContent = `${t.toFixed(3)}s / ${dur.toFixed(3)}s`;
  }
  const nextSegmentIdx = getSegmentIndexByTime(t);
  if (nextSegmentIdx !== state.activeSegmentIdx) {
    state.activeSegmentIdx = nextSegmentIdx;
    syncMidiTextFromNotes();
  }
  drawNotes();
  drawRuler();
  syncSynthToPlayhead();
}

function buildSegmentPayload() {
  const segs = getSegments();
  return segs.map((seg) => {
    const midi = state.notes
      .filter((n) => n.segmentIdx === seg.idx)
      .map((n) => n.midi)
      .sort((a, b) => a - b);
    return {
      start: Number(seg.start.toFixed(3)),
      midi
    };
  });
}

function addSplitAtTime(t) {
  const dur = getAudioDuration();
  const tt = clamp(t, 0.01, Math.max(0.01, dur - 0.01));
  const hasNear = state.splitLines.some((s) => Math.abs(s.time - tt) < 0.01);
  if (hasNear) return;
  state.splitLines.push({ id: uid(), time: tt });
  drawNotes();
  drawRuler();
  syncSynthToPlayhead();
}

function newNote(start, end, midi, segmentIdx) {
  return {
    id: uid(),
    start,
    end,
    midi,
    segmentIdx
  };
}

function loadSample(sample) {
  state.current = sample;
  state.notes = [];
  state.splitLines = [];
  stopMixScheduler();
  state.selectedIds.clear();
  state.activeSegmentIdx = 0;
  syncMidiTextFromNotes();
  const bytes = Uint8Array.from(atob(sample.audio_b64), (c) => c.charCodeAt(0));
  const blob = new Blob([bytes], { type: 'audio/mpeg' });
  if (state.audioUrl) URL.revokeObjectURL(state.audioUrl);
  state.audioUrl = URL.createObjectURL(blob);
  ui.audio.src = state.audioUrl;
  ui.audio.currentTime = 0;
  applyMixVolumes();
  ui.meta.textContent = `编号 ${sample.index} | 截取 ${sample.start.toFixed(3)}s ~ ${(sample.start + sample.duration).toFixed(3)}s | ${sample.url}`;
  decodeLoadedAudio(blob).catch((e) => setStatus(e.message || '频谱分析失败'));
  updatePlayheadUi();
}

function canvasMetrics(evt) {
  const rect = ui.notes.getBoundingClientRect();
  const w = ui.notes.width;
  const h = ui.notes.height;
  const dur = getAudioDuration();
  const x = ((evt.clientX - rect.left) / rect.width) * w;
  const y = ((evt.clientY - rect.top) / rect.height) * h;
  return { rect, w, h, dur, x, y };
}

function hitTest(x, y, w, h) {
  const nh = Math.max(5, h / (MIDI_MAX - MIDI_MIN + 1));
  const edgePx = 6;
  const dur = getAudioDuration();
  const playX = tToX(getPlayheadTime(), dur, w);
  if (Math.abs(x - playX) <= 6) return { playhead: true };
  for (let i = state.splitLines.length - 1; i >= 0; i -= 1) {
    const line = state.splitLines[i];
    const lx = tToX(line.time, dur, w);
    if (Math.abs(x - lx) <= 6) return { split: line };
  }
  for (let i = state.notes.length - 1; i >= 0; i -= 1) {
    const n = state.notes[i];
    const segs = getSegments();
    const seg = segs[n.segmentIdx];
    if (!seg) continue;
    const x0 = tToX(seg.start, dur, w);
    const x1 = tToX(seg.end, dur, w);
    if (x < x0 || x > x1) continue;
    const yy = midiToY(n.midi, h);
    if (y >= yy - nh * 0.5 - edgePx && y <= yy + nh * 0.5 + edgePx) {
      return { note: n };
    }
  }
  return null;
}

ui.notes.addEventListener('pointerdown', (evt) => {
  if (evt.button === 2) evt.preventDefault();
  const { h, y, w, x, dur } = canvasMetrics(evt);
  const hit = hitTest(x, y, w, h);
  if (evt.button === 2) {
    if (hit && hit.split) {
      state.splitLines = state.splitLines.filter((s) => s.id !== hit.split.id);
      drawNotes();
      drawRuler();
      syncSynthToPlayhead();
      return;
    }
    if (hit && hit.note) {
      state.notes = state.notes.filter((n) => n.id !== hit.note.id);
      state.selectedIds.delete(hit.note.id);
      drawNotes();
      syncMidiTextFromNotes();
      syncSynthToPlayhead();
    }
    return;
  }
  if (evt.button !== 0) return;
  if (hit && hit.playhead) {
    state.draggingPlayheadLine = true;
    return;
  }
  if (hit && hit.split) {
    state.draggingSplitId = hit.split.id;
    return;
  }
  state.activeSegmentIdx = getSegmentIndexByTime(getPlayheadTime());
  if (hit) {
    state.selectedIds.clear();
    state.selectedIds.add(hit.note.id);
    drawNotes();
    playPreview(hit.note.midi, 0.25);
    return;
  }
  const midi = yToMidi(y, h);
  const seg = getSegments()[state.activeSegmentIdx];
  const exists = state.notes.find((n) => n.segmentIdx === state.activeSegmentIdx && n.midi === midi);
  if (exists) {
    state.notes = state.notes.filter((n) => n.id !== exists.id);
    drawNotes();
    syncMidiTextFromNotes();
    syncSynthToPlayhead();
    return;
  }
  const note = newNote(seg.start, seg.end, midi, state.activeSegmentIdx);
  state.notes.push(note);
  state.selectedIds.clear();
  state.selectedIds.add(note.id);
  drawNotes();
  syncMidiTextFromNotes();
  syncSynthToPlayhead();
  playPreview(midi, 0.25);
});

ui.notes.addEventListener('contextmenu', (evt) => {
  evt.preventDefault();
});

ui.notes.addEventListener('pointermove', (evt) => {
  const { h, y, w, x, dur } = canvasMetrics(evt);
  if (state.draggingPlayheadLine) {
    setPlayheadTime(xToT(x, dur, w));
    updatePlayheadUi();
    return;
  }
  if (state.draggingSplitId) {
    const idx = state.splitLines.findIndex((s) => s.id === state.draggingSplitId);
    if (idx >= 0) {
      state.splitLines[idx].time = clamp(xToT(x, dur, w), 0.01, Math.max(0.01, dur - 0.01));
      drawNotes();
      drawRuler();
      syncSynthToPlayhead();
    }
    return;
  }
  const hit = hitTest(x, y, w, h);
  ui.notes.style.cursor = (hit && (hit.playhead || hit.split)) ? 'ew-resize' : 'default';
  const nextHoverId = hit && hit.note ? hit.note.id : null;
  if (nextHoverId !== state.hoverId) {
    state.hoverId = nextHoverId;
    drawNotes();
  }
});

ui.notes.addEventListener('pointerup', () => {
  state.draggingSplitId = null;
  state.draggingPlayheadLine = false;
});

ui.notes.addEventListener('pointerleave', () => {
  ui.notes.style.cursor = 'default';
  if (state.draggingPlayheadLine) return;
  if (state.hoverId !== null) {
    state.hoverId = null;
    drawNotes();
  }
});

ui.midi.addEventListener('change', () => {
  const mids = parseMidiInput(ui.midi.value);
  const seg = getSegments()[state.activeSegmentIdx];
  state.notes = state.notes.filter((n) => n.segmentIdx !== state.activeSegmentIdx);
  state.notes.push(...mids.map((m) => newNote(seg.start, seg.end, m, state.activeSegmentIdx)));
  state.selectedIds.clear();
  drawNotes();
  syncSynthToPlayhead();
});

if (ui.enterBtn) {
  ui.enterBtn.addEventListener('click', async () => {
    if (state.entering) return;
    try {
      state.entering = true;
      ui.enterBtn.disabled = true;
      ui.enterBtn.textContent = '加载中...';
      const dir = (ui.saveDirInput?.value || '').trim();
      if (!dir) return;
      setStatus('初始化中：正在准备首条候选音频...');
      const data = await post('/start', { save_dir: dir });
      state.started = true;
      ensureStatusPolling();
      ui.startPage?.classList.add('hidden');
      ui.annotPage?.classList.remove('hidden');
      loadSample(data.sample);
      ui.text.value = '';
      setStatus(`已开始，当前编号 ${data.sample.index}`);
    } catch (e) {
      setStatus(e.message || '开始失败');
    } finally {
      state.entering = false;
      if (!state.started) {
        ui.enterBtn.disabled = false;
        ui.enterBtn.textContent = '开始';
      }
    }
  });
}

ui.nextBtn.addEventListener('click', async () => {
  if (!state.started) return setStatus('请先点击开始');
  try {
    const chordText = ui.text.value.trim();
    if (!isValidChordText(chordText)) {
      setStatus('和弦格式错误：仅支持 N、G:maj、D:maj/G');
      return;
    }
    setStatus('保存并下载下一条...');
    const segments = buildSegmentPayload();
    const midi = [...new Set(segments.flatMap((s) => s.midi))].sort((a, b) => a - b);
    const data = await post('/save_and_next', { text: chordText, midi, segments });
    loadSample(data.sample);
    ui.text.value = '';
    setStatus(`已保存 #${data.saved_index}，当前 #${data.sample.index}`);
    refreshDownloadStatus();
  } catch (e) {
    setStatus(e.message || '保存失败');
  }
});

ui.skipBtn.addEventListener('click', async () => {
  if (!state.started) return setStatus('请先点击开始');
  try {
    setStatus('跳过并下载下一条...');
    const data = await post('/skip_and_next');
    loadSample(data.sample);
    ui.text.value = '';
    setStatus(`已跳过，当前 #${data.sample.index}`);
    refreshDownloadStatus();
  } catch (e) {
    setStatus(e.message || '跳过失败');
  }
});

drawPiano();
drawNotes();

if (ui.audioVol) {
  ui.audioVol.addEventListener('input', () => {
    state.audioVolume = Number(ui.audioVol.value || 0.85);
    applyMixVolumes();
  });
}
if (ui.noteVol) {
  ui.noteVol.addEventListener('input', () => {
    state.noteVolume = Number(ui.noteVol.value || 0.35);
    state.synthVoices.forEach((v) => {
      v.gain.gain.value = clamp(state.noteVolume, 0, 1);
    });
  });
}
if (ui.mixPlayBtn) {
  ui.mixPlayBtn.addEventListener('click', async () => {
    state.mixEnabled = !state.mixEnabled;
    updateMixButtonUi();
    syncSynthToPlayhead();
  });
}
ui.audio.addEventListener('pause', () => {
  stopPlayheadAnimation();
  stopMixScheduler();
});
ui.audio.addEventListener('ended', () => {
  stopPlayheadAnimation();
  stopMixScheduler();
});
ui.audio.addEventListener('loadedmetadata', updatePlayheadUi);
ui.audio.addEventListener('play', () => {
  syncSynthToPlayhead();
  startPlayheadAnimation();
});
ui.audio.addEventListener('seeking', () => {
  state.mixTriggered.clear();
  updatePlayheadUi();
});
if (ui.addSplitBtn) {
  ui.addSplitBtn.addEventListener('click', () => {
    addSplitAtTime(getPlayheadTime());
  });
}
window.addEventListener('pointerup', () => {
  state.draggingSplitId = null;
  state.draggingPlayheadLine = false;
});
window.addEventListener('keydown', async (evt) => {
  if (evt.code !== 'Space') return;
  if (evt.target && ['INPUT', 'TEXTAREA'].includes(evt.target.tagName)) return;
  evt.preventDefault();
  const ctx = ensureAudioCtx();
  if (ctx.state === 'suspended') await ctx.resume();
  if (ui.audio.paused) {
    await ui.audio.play();
    syncSynthToPlayhead();
  } else {
    ui.audio.pause();
  }
});
if (ui.ruler) {
  ui.ruler.addEventListener('click', (evt) => {
    const rect = ui.ruler.getBoundingClientRect();
    const x = ((evt.clientX - rect.left) / rect.width) * ui.ruler.width;
    setPlayheadTime(xToT(x, getAudioDuration(), ui.ruler.width));
    updatePlayheadUi();
  });
  ui.ruler.addEventListener('mousemove', (evt) => {
    const rect = ui.ruler.getBoundingClientRect();
    const x = ((evt.clientX - rect.left) / rect.width) * ui.ruler.width;
    const playX = tToX(getPlayheadTime(), getAudioDuration(), ui.ruler.width);
    ui.ruler.style.cursor = Math.abs(x - playX) <= 6 ? 'ew-resize' : 'pointer';
  });
  ui.ruler.addEventListener('mouseleave', () => {
    ui.ruler.style.cursor = 'pointer';
  });
}
applyMixVolumes();
updateMixButtonUi();
updatePlayheadUi();
