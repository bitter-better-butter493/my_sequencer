/*
  ================================================================
  PawBeats - 爪拍 主逻辑
  ================================================================
  文件说明：核心 JavaScript 逻辑
  功能概述：
    - 音频引擎（AudioEngine）：Web Audio API 初始化、合成器、采样播放、
      效果器（混响/延迟/压缩）、音频导出
    - 音序器状态管理：旋律网格、鼓机网格、力度网格
    - 撤销/重做、复制/粘贴、静音/独奏
    - 渲染系统：动态生成音序器 UI、素材面板、鼓机面板
    - 播放控制：BPM、Swing、反向播放、Tap Tempo
    - 可视化：频谱/波形实时绘制
    - 主题切换、键盘快捷键、本地存储、URL 分享
  ================================================================
*/

const NOTES = [
  { label: 'C5',  freq: 523.25,  color: '#e0e0e0' },
  { label: 'B4',  freq: 493.88,  color: '#e0e0e0' },
  { label: 'A#4', freq: 466.16,  color: '#e0e0e0' },
  { label: 'A4',  freq: 440.00,  color: '#e0e0e0' },
  { label: 'G#4', freq: 415.30,  color: '#e0e0e0' },
  { label: 'G4',  freq: 392.00,  color: '#e0e0e0' },
  { label: 'F#4', freq: 369.99,  color: '#e0e0e0' },
  { label: 'F4',  freq: 349.23,  color: '#e0e0e0' },
  { label: 'E4',  freq: 329.63,  color: '#e0e0e0' },
  { label: 'D#4', freq: 311.13,  color: '#e0e0e0' },
  { label: 'D4',  freq: 293.66,  color: '#e0e0e0' },
  { label: 'C#4', freq: 277.18,  color: '#e0e0e0' },
  { label: 'C4',  freq: 261.63,  color: '#e0e0e0' },
];
const COLS = 16;
const NOTE_ROWS = NOTES.length;
const BASE_FREQ = 261.63; // C4 为素材基准频率

// 素材池：8个槽位
const SAMPLE_COLORS = ['#ff0055','#ff6600','#ffdd00','#33ff00','#00ffcc','#0088ff','#aa00ff','#ff00aa'];
const SAMPLE_SLOTS = 8;
const BUILTIN_NAMES = ['∿ Sine','△ Triangle','⊓ Square','⋀ Saw','⊓ Pulse','✦ FM','☁ Noise','☰ Organ'];
let samplePool = [];
for (let i = 0; i < SAMPLE_SLOTS; i++) {
  samplePool.push({ name: BUILTIN_NAMES[i], color: SAMPLE_COLORS[i], buffer: null, pitchBuffers: {} });
}
let selectedSlot = 0;
let currentPresetCategory = 'builtin'; // 'builtin' | 'cat' | 'robot'

// 预设分类定义
const PRESET_CATEGORIES = [
  { id: 'builtin', name: '🎹 合成', icon: '🎹' },
  { id: 'cat', name: '🐱 猫叫', icon: '🐱' },
  { id: 'robot', name: '🤖 机器人', icon: '🤖' },
  { id: 'dog', name: '🐶 狗叫', icon: '🐶' },
  { id: 'hakimi', name: '🎵 哈基米', icon: '🎵' },
  { id: 'user', name: '📁 我的', icon: '📁' },
];

// 旋律网格：每个格子存 slotIndex (0-7) 或 null
let noteGrid = [];
for (let r = 0; r < NOTE_ROWS; r++) { noteGrid[r] = new Array(COLS).fill(null); }

// 鼓机
const DRUMS = [
  { name: 'Kick',  color: '#ff3366' },
  { name: 'Snare', color: '#ffaa00' },
  { name: 'HiHat', color: '#00e5ff' },
  { name: 'Clap',  color: '#aa66ff' },
];
const DRUM_ROWS = DRUMS.length;
let drumGrid = [];
for (let r = 0; r < DRUM_ROWS; r++) { drumGrid[r] = new Array(COLS).fill(false); }

// 力度网格：1=轻(柔和), 2=中(正常), 3=重(强烈)
let velGrid = [];
for (let r = 0; r < NOTE_ROWS; r++) { velGrid[r] = new Array(COLS).fill(2); }
let drumVelGrid = [];
for (let r = 0; r < DRUM_ROWS; r++) { drumVelGrid[r] = new Array(COLS).fill(2); }

// === Undo/Redo ===
const undoStack = [];
const redoStack = [];
const MAX_UNDO = 50;

// 将当前网格状态压入撤销栈
function pushUndo() {
  undoStack.push({
    noteGrid: noteGrid.map(r => [...r]),
    drumGrid: drumGrid.map(r => [...r]),
    velGrid: velGrid.map(r => [...r]),
    drumVelGrid: drumVelGrid.map(r => [...r]),
  });
  if (undoStack.length > MAX_UNDO) undoStack.shift();
  redoStack.length = 0;
}

// 撤销上一步操作
function doUndo() {
  if (!undoStack.length) { showToast('Nothing to undo', ''); return; }
  redoStack.push({
    noteGrid: noteGrid.map(r => [...r]),
    drumGrid: drumGrid.map(r => [...r]),
    velGrid: velGrid.map(r => [...r]),
    drumVelGrid: drumVelGrid.map(r => [...r]),
  });
  const s = undoStack.pop();
  noteGrid = s.noteGrid; drumGrid = s.drumGrid; velGrid = s.velGrid; drumVelGrid = s.drumVelGrid;
  renderAll();
  showToast('Undo', '');
}

// 重做被撤销的操作
function doRedo() {
  if (!redoStack.length) { showToast('Nothing to redo', ''); return; }
  undoStack.push({
    noteGrid: noteGrid.map(r => [...r]),
    drumGrid: drumGrid.map(r => [...r]),
    velGrid: velGrid.map(r => [...r]),
    drumVelGrid: drumVelGrid.map(r => [...r]),
  });
  const s = redoStack.pop();
  noteGrid = s.noteGrid; drumGrid = s.drumGrid; velGrid = s.velGrid; drumVelGrid = s.drumVelGrid;
  renderAll();
  showToast('Redo', '');
}

// === Mute/Solo ===
let muteState = { melody: {}, drums: {} };
let soloMode = false;
let soloMelody = new Set();
let soloDrums = new Set();

// === Copy/Paste ===
let clipboard = null;
let selStart = null;
let selEnd = null;

// === Tap Tempo ===
let tapTimes = [];

// === Scale Lock ===
const SCALES = {
  chromatic: { name: '全部', notes: [0,1,2,3,4,5,6,7,8,9,10,11,12] },
  pentatonic: { name: '五声', notes: [0,2,4,7,9,12] },
  major: { name: '大调', notes: [0,2,4,5,7,9,11,12] },
  minor: { name: '小调', notes: [0,2,3,5,7,8,10,12] },
  blues: { name: '布鲁斯', notes: [0,3,5,6,7,10,12] },
};
let currentScale = 'chromatic';

// 根据当前音阶返回可用的音高行索引
function getScaleRows() {
  const scale = SCALES[currentScale].notes;
  return scale.map(n => 12 - n);
}

let currentDrumPreset = 'classic';

const DRUM_PRESETS = {
  classic: { name: '经典', icon: '🥁' },
  electronic: { name: '电子', icon: '🎛️' },
  hiphop: { name: '嘻哈', icon: '🎧' },
  percussion: { name: '打击', icon: '🪘' },
};

// 各预制的合成参数
const DRUM_SYNTHS = {
  classic: {
    Kick:  { type: 'sine', freq: 150, endFreq: 0.01, dur: 0.5, gain: 0.9 },
    Snare: { noiseDur: 0.2, noiseGain: 0.7, noiseFilt: 'highpass', noiseFreq: 1500, toneType: 'triangle', toneFreq: 200, toneGain: 0.3, toneDur: 0.1 },
    HiHat: { noiseDur: 0.05, noiseGain: 0.5, filt: 'highpass', freq: 8000, dur: 0.05 },
    Clap:  { noiseDur: 0.1, noiseGain: 0.4, filt: 'highpass', freq: 1500, dur: 0.08, layers: 3, layerGap: 0.015 },
  },
  electronic: {
    Kick:  { type: 'sine', freq: 200, endFreq: 30, dur: 0.3, gain: 1.0 },
    Snare: { noiseDur: 0.15, noiseGain: 0.5, noiseFilt: 'bandpass', noiseFreq: 3000, toneType: 'sawtooth', toneFreq: 180, toneGain: 0.4, toneDur: 0.08 },
    HiHat: { noiseDur: 0.08, noiseGain: 0.4, filt: 'highpass', freq: 10000, dur: 0.08 },
    Clap:  { noiseDur: 0.12, noiseGain: 0.5, filt: 'bandpass', freq: 2500, dur: 0.1, layers: 4, layerGap: 0.01 },
  },
  hiphop: {
    Kick:  { type: 'sine', freq: 80, endFreq: 0.01, dur: 0.6, gain: 1.0 },
    Snare: { noiseDur: 0.25, noiseGain: 0.8, noiseFilt: 'lowpass', noiseFreq: 4000, toneType: 'triangle', toneFreq: 160, toneGain: 0.35, toneDur: 0.12 },
    HiHat: { noiseDur: 0.04, noiseGain: 0.35, filt: 'highpass', freq: 9000, dur: 0.04 },
    Clap:  { noiseDur: 0.15, noiseGain: 0.6, filt: 'highpass', freq: 1200, dur: 0.12, layers: 2, layerGap: 0.02 },
  },
  percussion: {
    Kick:  { type: 'triangle', freq: 100, endFreq: 0.01, dur: 0.25, gain: 0.7 },
    Snare: { noiseDur: 0.3, noiseGain: 0.5, noiseFilt: 'bandpass', noiseFreq: 5000, toneType: 'sine', toneFreq: 300, toneGain: 0.2, toneDur: 0.05 },
    HiHat: { noiseDur: 0.1, noiseGain: 0.6, filt: 'bandpass', freq: 6000, dur: 0.1 },
    Clap:  { noiseDur: 0.08, noiseGain: 0.45, filt: 'bandpass', freq: 4000, dur: 0.06, layers: 3, layerGap: 0.012 },
  },
};

let state = {
  bpm: 128, volume: 0.8, isPlaying: false,
  currentStep: -1, timer: null, wave: 'triangle',
  swing: 0, particles: true, reverse: false,
  reverb: false, delay: false
};

// ================================================================
//  音频引擎：Web Audio API 初始化、采样播放、合成器、效果器
// ================================================================

// Base64 字符串转为 ArrayBuffer，用于解码嵌入的音频数据
function base64ToArrayBuffer(base64) {
  const binary = atob(base64);
  const len = binary.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}
// 音频引擎类：管理 Web Audio API 上下文、节点图、采样与合成
class AudioEngine {
  constructor() {
    this.ctx = null; this.master = null; this.analyser = null;
    this.initialized = false;
    this.drumSamples = {};
  }
  init() {
    if (this.initialized) return;
    // 创建音频上下文（兼容旧版 WebKit 前缀）
    this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    // 主音量增益节点，所有声音最终汇总到这里
    this.master = this.ctx.createGain();
    this.master.gain.value = state.volume;

    // 混响效果器：用卷积器模拟空间感，buffer 为算法生成的脉冲响应
    this.reverb = this.ctx.createConvolver();
    this.reverb.buffer = this.createReverbBuffer();
    this.reverbGain = this.ctx.createGain();
    this.reverbGain.gain.value = 0;
    this.master.connect(this.reverbGain);
    this.reverbGain.connect(this.reverb);

    // 延迟效果器：4秒最大延迟，带反馈回路产生回声
    this.delay = this.ctx.createDelay(4.0);
    this.delayGain = this.ctx.createGain();
    this.delayGain.gain.value = 0;
    this.feedback = this.ctx.createGain();
    this.feedback.gain.value = 0.4;
    this.master.connect(this.delayGain);
    this.delayGain.connect(this.delay);
    this.delay.connect(this.feedback);
    this.feedback.connect(this.delay);

    // 分析器节点：采集音频数据供可视化器使用，FFT 大小 256
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 256;
    // 将主输出、混响、延迟都连接到分析器，确保可视化能看到所有效果
    this.master.connect(this.analyser);
    this.reverb.connect(this.analyser);
    this.delay.connect(this.analyser);

    // 动态压缩器：防止音量过大导致爆音，自动平衡响度
    this.compressor = this.ctx.createDynamicsCompressor();
    this.compressor.threshold.value = -24;
    this.compressor.knee.value = 30;
    this.compressor.ratio.value = 12;
    this.compressor.attack.value = 0.003;
    this.compressor.release.value = 0.25;
    this.analyser.connect(this.compressor);
    this.reverb.connect(this.compressor);
    this.delay.connect(this.compressor);
    this.compressor.connect(this.ctx.destination);

    // 导出 WAV 用的录制目标：将压缩器输出连接到 MediaStream，供 MediaRecorder 录制
    this.recorderDest = this.ctx.createMediaStreamDestination();
    this.compressor.connect(this.recorderDest);
    this.initialized = true;
  }
  // 生成混响脉冲响应缓冲区：1.5秒立体声，白噪声按平方衰减模拟房间混响
  createReverbBuffer() {
    const rate = this.ctx.sampleRate;
    const length = Math.floor(rate * 1.5);
    const buffer = this.ctx.createBuffer(2, length, rate);
    for (let ch = 0; ch < 2; ch++) {
      const data = buffer.getChannelData(ch);
      for (let i = 0; i < length; i++) {
        data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / length, 2);
      }
    }
    return buffer;
  }
  toggleReverb(on) {
    if (!this.reverbGain) return;
    this.reverbGain.gain.setTargetAtTime(on ? 0.35 : 0, this.ctx.currentTime, 0.1);
  }
  toggleDelay(on) {
    if (!this.delayGain) return;
    this.delayGain.gain.setTargetAtTime(on ? 0.3 : 0, this.ctx.currentTime, 0.1);
  }
  resume() { if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume(); }
  setVolume(v) { state.volume = v; if (this.master) this.master.gain.value = v; }
  getAnalyser() { return this.analyser; }

  // 播放旋律音符：优先使用采样（通过 pitchShift 变调），无采样则用合成器
  playMelody(slotIdx, rowFreq, vel = 2) {
    // 根据力度值调整音量倍数：轻 0.5x、中 0.75x、重 1.0x
    const mult = vel === 1 ? 0.5 : vel === 2 ? 0.75 : 1.0;
    const sample = samplePool[slotIdx];
    if (sample && sample.buffer) {
      this.init(); this.resume();
      // 计算目标频率与基准频率的比值，用于变调
      const rate = rowFreq / BASE_FREQ;
      // 缓存已变调后的缓冲区，避免重复计算
      let buf = sample.pitchBuffers[rate];
      if (!buf) {
        buf = this.pitchShiftBuffer(sample.buffer, rate);
        sample.pitchBuffers[rate] = buf;
      }
      const s = this.ctx.createBufferSource();
      s.buffer = buf;
      s.playbackRate.value = 1.0;
      const g = this.ctx.createGain();
      g.gain.value = state.volume * 0.9 * mult;
      s.connect(g); g.connect(this.master);
      s.start();
      return;
    }
    // 如果没有采样，退化为合成器音色
    this.playSynth(rowFreq, mult);
  }

  // 使用振荡器合成音色：ADSR 简易包络（快速 attack、短 decay）
  playSynth(freq, mult = 0.9) {
    this.init(); this.resume();
    const ctx = this.ctx, t = ctx.currentTime;
    const o = ctx.createOscillator();
    o.type = state.wave;
    o.frequency.value = freq;
    const g = ctx.createGain();
    // 包络：0ms 开始 → 10ms 达到峰值 → 280ms 衰减到几乎无声
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.25 * mult, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.28);
    o.connect(g); g.connect(this.master);
    o.start(t); o.stop(t + 0.3);
  }

  // 播放鼓声：优先使用用户上传的采样，否则用程序合成
  playDrum(name, vel = 2) {
    // 力度倍数：轻 0.4x、中 0.9x、重 1.3x
    const mult = vel === 1 ? 0.4 : vel === 3 ? 1.3 : 0.9;
    if (this.playDrumSample(name, mult)) return;
    this.playDrumSynth(name, mult);
  }
  playDrumSample(name, mult = 0.9) {
    const buffer = this.drumSamples[name];
    if (!buffer) return false;
    this.init(); this.resume();
    const s = this.ctx.createBufferSource();
    s.buffer = buffer;
    const g = this.ctx.createGain();
    g.gain.value = state.volume * 0.9 * mult;
    s.connect(g); g.connect(this.master);
    s.start();
    return true;
  }
  playDrumSynth(name, mult = 0.9) {
    this.init(); this.resume();
    const ctx = this.ctx, t = ctx.currentTime;
    const p = (DRUM_SYNTHS[currentDrumPreset] || DRUM_SYNTHS.classic)[name];
    if (!p) return;

    if (name === 'Kick') {
      const o = ctx.createOscillator();
      o.type = p.type || 'sine';
      o.frequency.setValueAtTime(p.freq, t);
      o.frequency.exponentialRampToValueAtTime(Math.max(p.endFreq, 0.01), t + p.dur);
      const g = ctx.createGain();
      g.gain.setValueAtTime(p.gain * mult, t);
      g.gain.exponentialRampToValueAtTime(0.001, t + p.dur);
      o.connect(g); g.connect(this.master);
      o.start(t); o.stop(t + p.dur);
    } else if (name === 'Snare') {
      const noise = ctx.createBufferSource();
      const buf = ctx.createBuffer(1, Math.floor(ctx.sampleRate * p.noiseDur), ctx.sampleRate);
      const data = buf.getChannelData(0);
      for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
      noise.buffer = buf;
      const filt = ctx.createBiquadFilter();
      filt.type = p.noiseFilt || 'highpass';
      filt.frequency.value = p.noiseFreq || 1500;
      const g = ctx.createGain();
      g.gain.setValueAtTime(p.noiseGain * mult, t);
      g.gain.exponentialRampToValueAtTime(0.001, t + p.noiseDur);
      noise.connect(filt); filt.connect(g); g.connect(this.master);
      noise.start(t);
      if (p.toneType) {
        const o = ctx.createOscillator();
        o.type = p.toneType; o.frequency.value = p.toneFreq;
        const g2 = ctx.createGain();
        g2.gain.setValueAtTime(p.toneGain * mult, t);
        g2.gain.exponentialRampToValueAtTime(0.001, t + p.toneDur);
        o.connect(g2); g2.connect(this.master);
        o.start(t); o.stop(t + p.toneDur);
      }
    } else if (name === 'HiHat') {
      const noise = ctx.createBufferSource();
      const buf = ctx.createBuffer(1, Math.floor(ctx.sampleRate * p.noiseDur), ctx.sampleRate);
      const data = buf.getChannelData(0);
      for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
      noise.buffer = buf;
      const filt = ctx.createBiquadFilter();
      filt.type = p.filt || 'highpass';
      filt.frequency.value = p.freq || 8000;
      const g = ctx.createGain();
      g.gain.setValueAtTime(p.noiseGain * mult, t);
      g.gain.exponentialRampToValueAtTime(0.001, t + p.dur);
      noise.connect(filt); filt.connect(g); g.connect(this.master);
      noise.start(t);
    } else if (name === 'Clap') {
      const layers = p.layers || 3;
      const gap = p.layerGap || 0.015;
      for (let i = 0; i < layers; i++) {
        const noise = ctx.createBufferSource();
        const buf = ctx.createBuffer(1, Math.floor(ctx.sampleRate * p.noiseDur), ctx.sampleRate);
        const data = buf.getChannelData(0);
        for (let j = 0; j < data.length; j++) data[j] = Math.random() * 2 - 1;
        noise.buffer = buf;
        const filt = ctx.createBiquadFilter();
        filt.type = p.filt || 'highpass';
        filt.frequency.value = p.freq || 1500;
        const g = ctx.createGain();
        const dt = t + i * gap;
        g.gain.setValueAtTime(p.noiseGain * mult, dt);
        g.gain.exponentialRampToValueAtTime(0.001, dt + p.dur);
        noise.connect(filt); filt.connect(g); g.connect(this.master);
        noise.start(dt);
      }
    }
  }

  async loadSample(slotIdx, file) {
    this.init();
    try {
      const ab = await file.arrayBuffer();
      const buf = await this.ctx.decodeAudioData(ab);
      samplePool[slotIdx].buffer = buf;
      samplePool[slotIdx].pitchBuffers = {};
      return true;
    } catch (e) { console.error(e); return false; }
  }
  async loadDrumSample(name, file) {
    this.init();
    try {
      const ab = await file.arrayBuffer();
      const buf = await this.ctx.decodeAudioData(ab);
      this.drumSamples[name] = buf;
      return true;
    } catch (e) { console.error(e); return false; }
  }

  previewSample(slotIdx) {
    const sample = samplePool[slotIdx];
    if (sample && sample.buffer) {
      this.init(); this.resume();
      const s = this.ctx.createBufferSource();
      s.buffer = sample.buffer;
      s.playbackRate.value = 1.0;
      const g = this.ctx.createGain();
      g.gain.value = state.volume * 0.9;
      s.connect(g); g.connect(this.master);
      s.start();
      return;
    }
    this.playSynth(BASE_FREQ);
  }

  // 时间拉伸：用重叠相加法（OLA）改变音频时长而保持音高
  timeStretch(inputBuffer, ratio) {
    const frameSize = 2048;   // 每帧样本数
    const hopSize = 512;      // 输入帧间隔
    const outputHopSize = Math.round(hopSize * ratio); // 输出帧间隔（按比率缩放）
    const inputData = inputBuffer.getChannelData(0);
    const inputLength = inputData.length;
    const outputLength = Math.round(inputLength * ratio);
    const outputBuffer = this.ctx.createBuffer(1, outputLength, inputBuffer.sampleRate);
    const outputData = outputBuffer.getChannelData(0);
    // 初始化为 0，准备叠加
    for (let i = 0; i < outputLength; i++) outputData[i] = 0;
    // 汉宁窗：减少帧边界处的频谱泄漏
    const hann = new Float32Array(frameSize);
    for (let i = 0; i < frameSize; i++) {
      hann[i] = 0.5 * (1 - Math.cos(2 * Math.PI * i / (frameSize - 1)));
    }
    let outputPos = 0;
    // 逐帧读取输入，加窗后叠加到输出缓冲区
    for (let inputPos = 0; inputPos + frameSize < inputLength; inputPos += hopSize) {
      for (let i = 0; i < frameSize; i++) {
        const sample = inputData[Math.min(inputPos + i, inputLength - 1)] * hann[i];
        const outIdx = outputPos + i;
        if (outIdx >= 0 && outIdx < outputLength) outputData[outIdx] += sample;
      }
      outputPos += outputHopSize;
    }
    let maxVal = 0;
    for (let i = 0; i < outputLength; i++) maxVal = Math.max(maxVal, Math.abs(outputData[i]));
    if (maxVal > 1) for (let i = 0; i < outputLength; i++) outputData[i] /= maxVal;
    return outputBuffer;
  }

  // 音高偏移：先重采样改变音高（同时改变时长），再用时间拉伸恢复原始时长
  pitchShiftBuffer(buffer, rate) {
    if (Math.abs(rate - 1.0) < 0.001) return buffer; // 无需变调直接返回
    const inputData = buffer.getChannelData(0);
    const newLength = Math.round(inputData.length / rate);
    const resampled = new Float32Array(newLength);
    // 线性插值重采样
    for (let i = 0; i < newLength; i++) {
      const srcIdx = i * rate;
      const idx0 = Math.floor(srcIdx);
      const idx1 = Math.min(idx0 + 1, inputData.length - 1);
      const frac = srcIdx - idx0;
      resampled[i] = inputData[idx0] * (1 - frac) + inputData[idx1] * frac;
    }
    const tempBuffer = this.ctx.createBuffer(1, resampled.length, buffer.sampleRate);
    tempBuffer.getChannelData(0).set(resampled);
    // 时间拉伸补偿：将时长恢复为原始长度
    return this.timeStretch(tempBuffer, rate);
  }

  // 生成 8 种内置合成器采样：正弦、三角、方波、锯齿、脉冲、FM、噪声、风琴
  generateBuiltInSamples() {
    this.init();
    if (this.builtInReady) return;
    const sr = this.ctx.sampleRate;
    const makeBuf = (dur) => this.ctx.createBuffer(1, Math.floor(sr * dur), sr);
    const f0 = 261.63; // C4 基准频率

    // ADSR 包络辅助函数：attack, decay, sustainLevel, release, totalDuration
    const env = (t, a, d, sLvl, r, total) => {
      if (t < a) return t / a;
      if (t < a + d) return 1 - (1 - sLvl) * ((t - a) / d);
      if (t < total - r) return sLvl;
      return sLvl * (total - t) / r;
    };

    // 1. 正弦波：最纯净的单一频率音色
    {
      const b = makeBuf(0.5);
      const d = b.getChannelData(0);
      for (let i = 0; i < d.length; i++) {
        const t = i / sr;
        const e = env(t, 0.02, 0.1, 0.7, 0.2, 0.5);
        d[i] = Math.sin(2 * Math.PI * f0 * t) * e * 0.9;
      }
      samplePool[0].buffer = b;
      samplePool[0].pitchBuffers = {};
    }

    // 2. 三角波：比正弦波更明亮，但比方波柔和
    {
      const b = makeBuf(0.4);
      const d = b.getChannelData(0);
      for (let i = 0; i < d.length; i++) {
        const t = i / sr;
        const ph = (f0 * t) % 1;
        const tri = ph < 0.5 ? (ph * 4 - 1) : (3 - ph * 4);
        const e = env(t, 0.01, 0.08, 0.6, 0.15, 0.4);
        d[i] = tri * e * 0.8;
      }
      samplePool[1].buffer = b;
      samplePool[1].pitchBuffers = {};
    }

    // 3. 方波：空心、复古游戏机的音色
    {
      const b = makeBuf(0.4);
      const d = b.getChannelData(0);
      for (let i = 0; i < d.length; i++) {
        const t = i / sr;
        const ph = (f0 * t) % 1;
        const e = env(t, 0.01, 0.08, 0.6, 0.15, 0.4);
        d[i] = (ph < 0.5 ? 1 : -1) * e * 0.7;
      }
      samplePool[2].buffer = b;
      samplePool[2].pitchBuffers = {};
    }

    // 4. 锯齿波：最明亮、富含谐波的音色
    {
      const b = makeBuf(0.4);
      const d = b.getChannelData(0);
      for (let i = 0; i < d.length; i++) {
        const t = i / sr;
        const ph = (f0 * t) % 1;
        const e = env(t, 0.01, 0.08, 0.6, 0.15, 0.4);
        d[i] = (ph * 2 - 1) * e * 0.7;
      }
      samplePool[3].buffer = b;
      samplePool[3].pitchBuffers = {};
    }

    // 5. 窄脉冲波：占空比 25%，尖锐的簧片感音色
    {
      const b = makeBuf(0.4);
      const d = b.getChannelData(0);
      for (let i = 0; i < d.length; i++) {
        const t = i / sr;
        const ph = (f0 * t) % 1;
        const e = env(t, 0.01, 0.08, 0.6, 0.15, 0.4);
        d[i] = (ph < 0.1 ? 1 : -1) * e * 0.7;
      }
      samplePool[4].buffer = b;
      samplePool[4].pitchBuffers = {};
    }

    // 6. FM (carrier 261.63, modulator 174.42, index 3)
    {
      const b = makeBuf(0.4);
      const d = b.getChannelData(0);
      const fc = f0, fm = f0 * 2 / 3, idx = 3;
      for (let i = 0; i < d.length; i++) {
        const t = i / sr;
        const e = env(t, 0.01, 0.1, 0.5, 0.15, 0.4);
        d[i] = Math.sin(2 * Math.PI * fc * t + idx * Math.sin(2 * Math.PI * fm * t)) * e * 0.8;
      }
      samplePool[5].buffer = b;
      samplePool[5].pitchBuffers = {};
    }

    // 7. 白噪声：随机频谱，用于打击乐或特殊音效
    {
      const b = makeBuf(0.2);
      const d = b.getChannelData(0);
      for (let i = 0; i < d.length; i++) {
        const t = i / sr;
        const e = env(t, 0.01, 0.05, 0.4, 0.1, 0.2);
        d[i] = (Math.random() * 2 - 1) * e * 0.8;
      }
      samplePool[6].buffer = b;
      samplePool[6].pitchBuffers = {};
    }

    // 8. Organ (square + odd harmonics)
    {
      const b = makeBuf(0.6);
      const d = b.getChannelData(0);
      const harmonics = [1, 3, 5, 7];
      const hAmps = [1, 0.33, 0.2, 0.14];
      for (let i = 0; i < d.length; i++) {
        const t = i / sr;
        let s = 0;
        for (let h = 0; h < harmonics.length; h++) {
          s += Math.sin(2 * Math.PI * f0 * harmonics[h] * t) * hAmps[h];
        }
        const e = env(t, 0.02, 0.1, 0.8, 0.3, 0.6);
        d[i] = s * e * 0.7;
      }
      samplePool[7].buffer = b;
      samplePool[7].pitchBuffers = {};
    }

    this.builtInReady = true;
  }
}
const audio = new AudioEngine();

// ================================================================
//  渲染系统：预设面板、素材库、音序器网格、鼓机网格
// ================================================================

// --- Preset bar ---
// 渲染左侧预设分类图标栏
function renderPresetBar() {
  const el = document.getElementById('preset-list');
  if (!el) return;
  el.innerHTML = '';
  PRESET_CATEGORIES.forEach(cat => {
    const btn = document.createElement('div');
    btn.className = 'preset-btn' + (currentPresetCategory === cat.id ? ' active' : '');
    btn.textContent = cat.icon;
    btn.title = cat.name;
    btn.onclick = () => switchPresetCategory(cat.id);
    el.appendChild(btn);
  });
}

// 切换素材预设分类（合成器/猫叫/狗叫/哈基米/自定义）
async function switchPresetCategory(catId) {
  if (state.isPlaying) return;
  if (catId === currentPresetCategory) return;
  currentPresetCategory = catId;
  selectedSlot = 0;

  if (catId === 'builtin') {
    // 恢复合成器预设名称
    audio.builtInReady = false;
    for (let i = 0; i < SAMPLE_SLOTS; i++) {
      samplePool[i].name = BUILTIN_NAMES[i];
      samplePool[i].buffer = null;
      samplePool[i].pitchBuffers = {};
    }
    audio.generateBuiltInSamples();
  } else if (catId === 'cat') {
    // 加载猫叫预设（前8个）
    await loadCatPreset();
  } else if (catId === 'robot') {
    await loadRobotPreset();
  } else if (catId === 'dog') {
    await loadDogPreset();
  } else if (catId === 'hakimi') {
    await loadHakimiPreset();
  } else if (catId === 'user') {
    for (let i = 0; i < SAMPLE_SLOTS; i++) {
      samplePool[i].name = '📁 Slot ' + (i + 1);
      samplePool[i].buffer = null;
      samplePool[i].pitchBuffers = {};
    }
  }

  renderPresetBar();
  renderSamples();
  showToast('Switched to: ' + PRESET_CATEGORIES.find(c => c.id === catId).name, '');
}

async function loadCatPreset() {
  if (typeof CAT_PRESETS === 'undefined') {
    showToast('Cat presets not loaded', 'err');
    return;
  }
  audio.init();
  for (let i = 0; i < SAMPLE_SLOTS; i++) {
    if (i < CAT_PRESETS.length) {
      const CAT_ICONS = ['🐱','😺','😸','😹','😻','😼','😽','🙀'];
      samplePool[i].name = CAT_ICONS[i] || '🐱';
      try {
        const ab = base64ToArrayBuffer(CAT_PRESETS[i].data);
        samplePool[i].buffer = await audio.ctx.decodeAudioData(ab);
        samplePool[i].pitchBuffers = {};
      } catch (e) {
        console.error('Failed to decode cat preset', i, e);
        samplePool[i].buffer = null;
        samplePool[i].pitchBuffers = {};
      }
    } else {
      samplePool[i].name = 'Empty';
      samplePool[i].buffer = null;
      samplePool[i].pitchBuffers = {};
    }
  }
}

// 加载机器人预设：用程序合成 8 种机器人音效
function loadRobotPreset() {
  audio.init();
  const sr = audio.ctx.sampleRate;
  const makeBuf = (dur) => audio.ctx.createBuffer(1, Math.floor(sr * dur), sr);

  // ADSR 包络辅助函数
  const env = (t, a, d, sLvl, r, total) => {
    if (t < a) return t / a;
    if (t < a + d) return 1 - (1 - sLvl) * ((t - a) / d);
    if (t < total - r) return sLvl;
    return sLvl * (total - t) / r;
  };

  const ROBOT_NAMES = ['🤖 Speak','🤖 Beep','🤖 Glitch','🤖 Laser','🤖 PowerUp','🤖 Alarm','🤖 Static','🤖 Error'];

  // 1. 机器人说话：方波 + 20Hz 颤音，模拟经典机器人嗓音
  {
    const b = makeBuf(0.35);
    const d = b.getChannelData(0);
    for (let i = 0; i < d.length; i++) {
      const t = i / sr;
      const f = 150 + 30 * Math.sin(2 * Math.PI * 20 * t);
      const phase = (f * t) % 1;
      const e = env(t, 0.01, 0.05, 0.7, 0.1, 0.35);
      d[i] = (phase < 0.5 ? 1 : -1) * e * 0.8;
    }
    samplePool[0].buffer = b;
    samplePool[0].name = ROBOT_NAMES[0];
    samplePool[0].pitchBuffers = {};
  }

  // 2. 数字哔声：纯净的正弦波，像电脑提示音
  {
    const b = makeBuf(0.15);
    const d = b.getChannelData(0);
    for (let i = 0; i < d.length; i++) {
      const t = i / sr;
      const e = env(t, 0.005, 0.02, 0.8, 0.05, 0.15);
      d[i] = Math.sin(2 * Math.PI * 880 * t) * e * 0.9;
    }
    samplePool[1].buffer = b;
    samplePool[1].name = ROBOT_NAMES[1];
    samplePool[1].pitchBuffers = {};
  }

  // 3. 故障音：每 30ms 随机跳变频率，产生数字故障感
  {
    const b = makeBuf(0.25);
    const d = b.getChannelData(0);
    let phase = 0;
    for (let i = 0; i < d.length; i++) {
      const t = i / sr;
      const stepLen = 0.03;
      const step = Math.floor(t / stepLen);
      const f = [200, 400, 150, 600, 300, 500, 250, 350][step % 8];
      phase += f / sr;
      const e = env(t, 0.005, 0.02, 0.7, 0.08, 0.25);
      d[i] = ((phase % 1) < 0.5 ? 1 : -1) * e * 0.7;
    }
    samplePool[2].buffer = b;
    samplePool[2].name = ROBOT_NAMES[2];
    samplePool[2].pitchBuffers = {};
  }

  // 4. 激光音：频率指数衰减下滑，科幻射击音效
  {
    const b = makeBuf(0.2);
    const d = b.getChannelData(0);
    let ph = 0;
    for (let i = 0; i < d.length; i++) {
      const t = i / sr;
      const f = 3000 * Math.exp(-t * 18);
      ph += f / sr;
      const saw = ((ph % 1) * 2 - 1);
      const e = env(t, 0.005, 0.05, 0.6, 0.1, 0.2);
      d[i] = saw * e * 0.7;
    }
    samplePool[3].buffer = b;
    samplePool[3].name = ROBOT_NAMES[3];
    samplePool[3].pitchBuffers = {};
  }

  // 5. 升级音：正弦波频率线性爬升，游戏升级音效
  {
    const b = makeBuf(0.4);
    const d = b.getChannelData(0);
    for (let i = 0; i < d.length; i++) {
      const t = i / sr;
      const f = 100 + 900 * (t / 0.4);
      const e = env(t, 0.02, 0.1, 0.8, 0.15, 0.4);
      d[i] = Math.sin(2 * Math.PI * f * t) * e * 0.8;
    }
    samplePool[4].buffer = b;
    samplePool[4].name = ROBOT_NAMES[4];
    samplePool[4].pitchBuffers = {};
  }

  // 6. Alarm - alternating two tones
  {
    const b = makeBuf(0.4);
    const d = b.getChannelData(0);
    for (let i = 0; i < d.length; i++) {
      const t = i / sr;
      const half = 0.1;
      const f = (t % (half * 2)) < half ? 800 : 1000;
      const e = env(t, 0.01, 0.05, 0.7, 0.1, 0.4);
      d[i] = Math.sin(2 * Math.PI * f * t) * e * 0.8;
    }
    samplePool[5].buffer = b;
    samplePool[5].name = ROBOT_NAMES[5];
    samplePool[5].pitchBuffers = {};
  }

  // 7. Static - filtered noise burst
  {
    const b = makeBuf(0.15);
    const d = b.getChannelData(0);
    let last = 0;
    for (let i = 0; i < d.length; i++) {
      const t = i / sr;
      const raw = Math.random() * 2 - 1;
      last = last * 0.7 + raw * 0.3; // lowpass
      const e = env(t, 0.005, 0.03, 0.5, 0.08, 0.15);
      d[i] = last * e * 0.9;
    }
    samplePool[6].buffer = b;
    samplePool[6].name = ROBOT_NAMES[6];
    samplePool[6].pitchBuffers = {};
  }

  // 8. Error - descending three-tone "bonk"
  {
    const b = makeBuf(0.25);
    const d = b.getChannelData(0);
    for (let i = 0; i < d.length; i++) {
      const t = i / sr;
      const tones = [600, 450, 300];
      const toneDur = 0.07;
      const toneIdx = Math.min(2, Math.floor(t / toneDur));
      const toneT = t - toneIdx * toneDur;
      const f = tones[toneIdx];
      const e2 = toneT < 0.01 ? toneT / 0.01 : Math.exp(-(toneT - 0.01) * 40);
      d[i] = Math.sin(2 * Math.PI * f * toneT) * e2 * 0.7;
    }
    samplePool[7].buffer = b;
    samplePool[7].name = ROBOT_NAMES[7];
    samplePool[7].pitchBuffers = {};
  }
}

async function loadDogPreset() {
  if (typeof DOG_PRESETS === 'undefined') {
    showToast('Dog presets not loaded', 'err');
    return;
  }
  audio.init();
  for (let i = 0; i < SAMPLE_SLOTS; i++) {
    if (i < DOG_PRESETS.length) {
      const DOG_ICONS = ['🐶','🐕','🐩','🦮','🐕‍🦺','🐾','🦴','🐺'];
      samplePool[i].name = DOG_ICONS[i] || '🐶';
      try {
        const ab = base64ToArrayBuffer(DOG_PRESETS[i].data);
        samplePool[i].buffer = await audio.ctx.decodeAudioData(ab);
        samplePool[i].pitchBuffers = {};
      } catch (e) {
        console.error('Failed to decode dog preset', i, e);
        samplePool[i].buffer = null;
        samplePool[i].pitchBuffers = {};
      }
    } else {
      samplePool[i].name = 'Empty';
      samplePool[i].buffer = null;
      samplePool[i].pitchBuffers = {};
    }
  }
}

async function loadHakimiPreset() {
  if (typeof HAKIMI_PRESETS === 'undefined') {
    showToast('Hakimi presets not loaded', 'err');
    return;
  }
  audio.init();
  for (let i = 0; i < SAMPLE_SLOTS; i++) {
    if (i < HAKIMI_PRESETS.length) {
      samplePool[i].name = HAKIMI_PRESETS[i].name;
      try {
        const ab = base64ToArrayBuffer(HAKIMI_PRESETS[i].data);
        samplePool[i].buffer = await audio.ctx.decodeAudioData(ab);
        samplePool[i].pitchBuffers = {};
      } catch (e) {
        console.error('Failed to decode hakimi preset', i, e);
        samplePool[i].buffer = null;
        samplePool[i].pitchBuffers = {};
      }
    } else {
      samplePool[i].name = 'Empty';
      samplePool[i].buffer = null;
      samplePool[i].pitchBuffers = {};
    }
  }
}

// 渲染素材库面板（8 个槽位）
function renderSamples() {
  const el = document.getElementById('sample-list');
  if (!el) return;
  el.innerHTML = '';
  const isUserCat = currentPresetCategory === 'user';
  for (let i = 0; i < SAMPLE_SLOTS; i++) {
    const s = samplePool[i];
    const slot = document.createElement('div');
    slot.className = 'sample-slot' + (i === selectedSlot ? ' selected' : '');
    slot.dataset.idx = i;
    slot.onclick = () => { selectedSlot = i; renderSamples(); };

    const color = document.createElement('div');
    color.className = 'slot-color';
    color.style.background = s.color;
    slot.appendChild(color);

    const name = document.createElement('div');
    name.className = 'slot-name';
    name.textContent = s.name;
    slot.appendChild(name);

    const preview = document.createElement('span');
    preview.className = 'slot-preview';
    preview.innerHTML = '🔊';
    preview.title = 'Preview';
    preview.onclick = (ev) => { ev.stopPropagation(); audio.previewSample(i); };
    slot.appendChild(preview);

    if (isUserCat) {
      const up = document.createElement('span');
      up.className = 'slot-upload' + (s.buffer ? ' has-sample' : '');
      up.innerHTML = s.buffer ? '✓' : '📁';
      up.title = s.buffer ? '点击替换音频' : '点击上传音频';
      up.onclick = (ev) => { ev.stopPropagation(); triggerSampleUpload(i, up); };
      slot.appendChild(up);
    }

    el.appendChild(slot);
  }
}

// 渲染旋律音序器网格（13 音高 × 16 步进）
function renderSeq() {
  const el = document.getElementById('seq-grid');
  el.innerHTML = '';
  const scaleRows = getScaleRows();
  for (let r = 0; r < NOTE_ROWS; r++) {
    const note = NOTES[r];
    const lbl = document.createElement('div');
    lbl.className = 'row-label';
    lbl.textContent = note.label;
    lbl.style.color = note.color;
    lbl.style.borderColor = note.color + '40';

    // 静音按钮
    const muteBtn = document.createElement('span');
    muteBtn.className = 'row-mute' + (muteState.melody[r] ? ' active' : '');
    muteBtn.innerHTML = 'M';
    muteBtn.title = '静音';
    muteBtn.onclick = (ev) => { ev.stopPropagation(); muteState.melody[r] = !muteState.melody[r]; renderSeq(); };
    lbl.appendChild(muteBtn);

    // 独奏按钮
    const soloBtn = document.createElement('span');
    soloBtn.className = 'row-solo' + (soloMelody.has(r) ? ' active' : '');
    soloBtn.innerHTML = 'S';
    soloBtn.title = '独奏';
    soloBtn.onclick = (ev) => {
      ev.stopPropagation();
      if (soloMelody.has(r)) { soloMelody.delete(r); if (!soloMelody.size) soloMode = false; }
      else { soloMelody.add(r); soloMode = true; }
      renderSeq();
    };
    lbl.appendChild(soloBtn);

    // 音阶锁定视觉
    const inScale = scaleRows.includes(r);
    if (!inScale && currentScale !== 'chromatic') lbl.style.opacity = '0.25';
    if (muteState.melody[r]) lbl.classList.add('muted');

    const dice = document.createElement('span');
    dice.className = 'row-dice';
    dice.innerHTML = '🎲';
    dice.title = 'Randomize row';
    dice.onclick = (ev) => { ev.stopPropagation(); randomMelodyRow(r); };
    lbl.appendChild(dice);
    el.appendChild(lbl);
    for (let c = 0; c < COLS; c++) {
      const cell = document.createElement('div');
      const slotIdx = noteGrid[r][c];
      const vel = slotIdx !== null ? (velGrid[r][c] || 2) : 0;
      cell.className = 'step-cell' + (slotIdx !== null ? ' active' : '') + (slotIdx !== null ? ' vel-' + vel : '');
      cell.dataset.row = r; cell.dataset.col = c;
      if (!inScale && currentScale !== 'chromatic') cell.style.opacity = '0.25';
      if (slotIdx !== null) {
        const color = samplePool[slotIdx]?.color || '#fff';
        cell.style.color = color;
      }
      cell.onclick = () => {
        pushUndo(); // 记录操作前的状态，供撤销使用
        const cur = noteGrid[r][c];
        // 点击循环：空 → 放置(力度1) → 力度2 → 力度3 → 移除
        if (cur === null) {
          noteGrid[r][c] = selectedSlot; velGrid[r][c] = 1;
        } else {
          const v = velGrid[r][c] || 1;
          if (v === 1) { velGrid[r][c] = 2; }
          else if (v === 2) { velGrid[r][c] = 3; }
          else { noteGrid[r][c] = null; velGrid[r][c] = 2; }
        }
        // 更新格子的视觉样式
        const slotIdx2 = noteGrid[r][c];
        const vel2 = slotIdx2 !== null ? (velGrid[r][c] || 2) : 0;
        cell.className = 'step-cell' + (slotIdx2 !== null ? ' active' : '') + (slotIdx2 !== null ? ' vel-' + vel2 : '');
        cell.style.color = slotIdx2 !== null ? (samplePool[slotIdx2]?.color || '#fff') : '';
      };
      el.appendChild(cell);
    }
  }
}

// 渲染鼓机网格（4 轨道 × 16 步进）
function renderDrums() {
  const el = document.getElementById('drum-grid');
  el.innerHTML = '';
  for (let r = 0; r < DRUM_ROWS; r++) {
    const d = DRUMS[r];
    const lbl = document.createElement('div');
    lbl.className = 'drum-label';
    lbl.textContent = d.name;
    lbl.style.color = d.color;
    lbl.style.borderColor = d.color + '40';

    // 静音按钮
    const muteBtn = document.createElement('span');
    muteBtn.className = 'drum-mute' + (muteState.drums[r] ? ' active' : '');
    muteBtn.innerHTML = 'M';
    muteBtn.title = '静音';
    muteBtn.onclick = (ev) => { ev.stopPropagation(); muteState.drums[r] = !muteState.drums[r]; renderDrums(); };
    lbl.appendChild(muteBtn);

    // 独奏按钮
    const soloBtn = document.createElement('span');
    soloBtn.className = 'drum-solo' + (soloDrums.has(r) ? ' active' : '');
    soloBtn.innerHTML = 'S';
    soloBtn.title = '独奏';
    soloBtn.onclick = (ev) => {
      ev.stopPropagation();
      if (soloDrums.has(r)) { soloDrums.delete(r); if (!soloDrums.size) soloMode = false; }
      else { soloDrums.add(r); soloMode = true; }
      renderDrums();
    };
    lbl.appendChild(soloBtn);

    if (muteState.drums[r]) lbl.classList.add('muted');

    const dice = document.createElement('span');
    dice.className = 'drum-dice';
    dice.innerHTML = '🎲';
    dice.title = 'Randomize row';
    dice.onclick = (ev) => { ev.stopPropagation(); randomDrumRow(r); };
    lbl.appendChild(dice);
    const up = document.createElement('span');
    up.className = 'upload-btn' + (audio.drumSamples[d.name] ? ' has-sample' : '');
    up.innerHTML = audio.drumSamples[d.name] ? '✓' : '📁';
    up.title = audio.drumSamples[d.name] ? 'Sample loaded' : 'Import sample';
    up.onclick = (ev) => { ev.stopPropagation(); triggerDrumUpload(d.name, up); };
    lbl.appendChild(up);
    el.appendChild(lbl);
    for (let c = 0; c < COLS; c++) {
      const cell = document.createElement('div');
      const isActive = drumGrid[r][c];
      const vel = isActive ? (drumVelGrid[r][c] || 2) : 0;
      cell.className = 'drum-cell' + (isActive ? ' active' : '') + (isActive ? ' vel-' + vel : '');
      cell.dataset.row = r; cell.dataset.col = c;
      if (isActive) cell.style.color = d.color;
      cell.onclick = () => {
        pushUndo();
        const cur = drumGrid[r][c];
        // 点击循环：空 → 放置(力度1) → 力度2 → 力度3 → 移除
        if (!cur) {
          drumGrid[r][c] = true; drumVelGrid[r][c] = 1;
        } else {
          const v = drumVelGrid[r][c] || 1;
          if (v === 1) { drumVelGrid[r][c] = 2; }
          else if (v === 2) { drumVelGrid[r][c] = 3; }
          else { drumGrid[r][c] = false; drumVelGrid[r][c] = 2; }
        }
        // 更新格子的视觉样式
        const isActive2 = drumGrid[r][c];
        const vel2 = isActive2 ? (drumVelGrid[r][c] || 2) : 0;
        cell.className = 'drum-cell' + (isActive2 ? ' active' : '') + (isActive2 ? ' vel-' + vel2 : '');
        cell.style.color = isActive2 ? d.color : '';
      };
      el.appendChild(cell);
    }
  }
}

// 渲染鼓机音色预设面板（经典/电子/嘻哈/打击）
function renderDrumPresetBar() {
  const el = document.getElementById('drum-preset-list');
  if (!el) return;
  el.innerHTML = '';
  for (const [id, preset] of Object.entries(DRUM_PRESETS)) {
    const btn = document.createElement('div');
    btn.className = 'drum-preset-btn' + (currentDrumPreset === id ? ' active' : '');
    btn.innerHTML = preset.icon;
    btn.title = preset.name;
    btn.onclick = () => switchDrumPreset(id);
    el.appendChild(btn);
  }
}

// 切换鼓机合成音色，清除用户上传的自定义采样
function switchDrumPreset(presetId) {
  if (state.isPlaying && presetId !== currentDrumPreset) return;
  pushUndo();
  currentDrumPreset = presetId;
  const preset = DRUM_PRESETS[presetId];
  if (!preset) return;
  // 切换音色时清除已上传的鼓采样，让合成器接管
  audio.drumSamples = {};
  renderDrumPresetBar();
  renderDrums();
  showToast('鼓音色: ' + preset.name, '');
}

// 重新渲染所有 UI 组件
function renderAll() {
  renderPresetBar();
  renderSamples();
  renderSeq();
  renderDrumPresetBar();
  renderDrums();
  renderSamplePresetSelect();
}

// 高亮当前播放的列：仅操作前后两列，避免全量遍历导致视觉滞后于声音
let _prevPlayCol = -1;
function updatePlayCol() {
  const col = state.currentStep;
  if (_prevPlayCol === col) return;
  // 移除上一列高亮
  if (_prevPlayCol >= 0) {
    document.querySelectorAll('[data-col="' + _prevPlayCol + '"].step-cell, [data-col="' + _prevPlayCol + '"].drum-cell')
      .forEach(c => c.classList.remove('play-col'));
  }
  // 添加当前列高亮
  if (state.isPlaying && col >= 0) {
    document.querySelectorAll('[data-col="' + col + '"].step-cell, [data-col="' + col + '"].drum-cell')
      .forEach(c => c.classList.add('play-col'));
  }
  _prevPlayCol = col;
}

// ================================================================
//  音频上传与裁剪
// ================================================================
// 裁剪状态对象：记录当前待裁剪音频的信息
let cropState = {
  buffer: null, slotIdx: 0, btnEl: null, duration: 0,
  start: 0, end: 2, dragging: false, dragMode: null
};

function triggerSampleUpload(slotIdx, btnEl) {
  let input = document.getElementById('sample-upload-input');
  if (!input) {
    input = document.createElement('input');
    input.type = 'file'; input.id = 'sample-upload-input';
    input.accept = 'audio/*'; input.style.display = 'none';
    document.body.appendChild(input);
  }
  input.value = '';
  input.onchange = async (ev) => {
    const file = ev.target.files[0];
    if (!file) return;
    showToast('Loading ' + file.name + '...', '');
    audio.init();
    try {
      const ab = await file.arrayBuffer();
      const buf = await audio.ctx.decodeAudioData(ab);
      if (buf.duration > 1) {
        showCropModal(buf, slotIdx, btnEl, file.name);
      } else {
        samplePool[slotIdx].buffer = buf;
        samplePool[slotIdx].pitchBuffers = {};
        if (currentPresetCategory === 'user') samplePool[slotIdx].name = file.name.split('.')[0].slice(0, 10);
        btnEl.innerHTML = '✓'; btnEl.title = file.name; btnEl.classList.add('has-sample');
        showToast(samplePool[slotIdx].name + ' loaded!', '');
      }
    } catch (e) { console.error(e); showToast('Failed to load', 'err'); }
  };
  input.click();
}

function triggerDrumUpload(name, btnEl) {
  let input = document.getElementById('drum-upload-input');
  if (!input) {
    input = document.createElement('input');
    input.type = 'file'; input.id = 'drum-upload-input';
    input.accept = 'audio/*'; input.style.display = 'none';
    document.body.appendChild(input);
  }
  input.value = '';
  input.onchange = async (ev) => {
    const file = ev.target.files[0];
    if (!file) return;
    showToast('Loading ' + name + '...', '');
    const ok = await audio.loadDrumSample(name, file);
    if (ok) {
      btnEl.innerHTML = '✓'; btnEl.title = file.name; btnEl.classList.add('has-sample');
      showToast(name + ' loaded!', '');
    } else {
      showToast(name + ' failed', 'err');
    }
  };
  input.click();
}

// 显示音频裁剪模态框：让用户选择最多 1 秒的片段
function showCropModal(buffer, slotIdx, btnEl, fileName) {
  cropState.buffer = buffer;
  cropState.slotIdx = slotIdx;
  cropState.btnEl = btnEl;
  cropState.duration = buffer.duration;
  cropState.start = 0;
  cropState.end = Math.min(1, buffer.duration);
  cropState.fileName = fileName;
  drawCropWaveform();
  updateCropUI();
  document.getElementById('crop-modal').classList.add('show');
  setupCropEvents();
  document.getElementById('crop-confirm').onclick = () => confirmCrop();
}

function drawCropWaveform() {
  const canvas = document.getElementById('crop-canvas');
  const ctx = canvas.getContext('2d');
  const wrap = canvas.parentElement;
  const w = wrap.clientWidth;
  const h = wrap.clientHeight;
  canvas.width = w; canvas.height = h;
  ctx.clearRect(0, 0, w, h);
  const data = cropState.buffer.getChannelData(0);
  const step = Math.ceil(data.length / w);
  const halfH = h / 2;
  ctx.strokeStyle = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#00e5ff';
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let x = 0; x < w; x++) {
    let min = 0, max = 0;
    for (let i = 0; i < step; i++) {
      const s = data[x * step + i] || 0;
      if (s < min) min = s; if (s > max) max = s;
    }
    ctx.moveTo(x, halfH + min * halfH * 0.9);
    ctx.lineTo(x, halfH + max * halfH * 0.9);
  }
  ctx.stroke();
}

function updateCropUI() {
  const wrap = document.querySelector('.crop-waveform-wrap');
  const w = wrap.clientWidth;
  const dur = cropState.duration;
  const leftPx = (cropState.start / dur) * w;
  const rightPx = (cropState.end / dur) * w;
  const region = document.getElementById('crop-region');
  const overlayL = document.getElementById('crop-overlay-left');
  const overlayR = document.getElementById('crop-overlay-right');
  region.style.left = leftPx + 'px';
  region.style.width = (rightPx - leftPx) + 'px';
  overlayL.style.width = leftPx + 'px';
  overlayR.style.width = (w - rightPx) + 'px';
  document.getElementById('crop-start').textContent = cropState.start.toFixed(2) + 's';
  document.getElementById('crop-end').textContent = cropState.end.toFixed(2) + 's';
  document.getElementById('crop-duration').textContent = (cropState.end - cropState.start).toFixed(2) + 's';
}

function setupCropEvents() {
  const wrap = document.querySelector('.crop-waveform-wrap');
  wrap.onmousedown = (e) => {
    const rect = wrap.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const w = rect.width;
    const dur = cropState.duration;
    const t = (x / w) * dur;
    const startDist = Math.abs(t - cropState.start);
    const endDist = Math.abs(t - cropState.end);
    if (startDist < endDist) {
      cropState.dragging = true; cropState.dragMode = 'start';
    } else {
      cropState.dragging = true; cropState.dragMode = 'end';
    }
  };
  window.onmousemove = (e) => {
    if (!cropState.dragging) return;
    const wrap = document.querySelector('.crop-waveform-wrap');
    const rect = wrap.getBoundingClientRect();
    const x = Math.max(0, Math.min(rect.width, e.clientX - rect.left));
    const dur = cropState.duration;
    const t = (x / rect.width) * dur;
    if (cropState.dragMode === 'start') {
      cropState.start = Math.max(0, Math.min(cropState.end - 0.1, t));
      if (cropState.end - cropState.start > 1) cropState.start = cropState.end - 1;
    } else {
      cropState.end = Math.min(dur, Math.max(cropState.start + 0.1, t));
      if (cropState.end - cropState.start > 1) cropState.end = cropState.start + 1;
    }
    updateCropUI();
  };
  window.onmouseup = () => { cropState.dragging = false; cropState.dragMode = null; };
}

// 确认裁剪：将选中的时间区间提取为新 AudioBuffer
function confirmCrop() {
  const buf = cropState.buffer;
  const sr = buf.sampleRate;
  const ch = buf.numberOfChannels;
  // 将秒转为采样点索引
  const startS = Math.floor(cropState.start * sr);
  const endS = Math.floor(cropState.end * sr);
  const len = endS - startS;
  const out = audio.ctx.createBuffer(ch, len, sr);
  // 逐声道复制选区数据
  for (let c = 0; c < ch; c++) {
    out.copyToChannel(buf.getChannelData(c).subarray(startS, endS), c);
  }
  const slotIdx = cropState.slotIdx;
  samplePool[slotIdx].buffer = out;
  samplePool[slotIdx].pitchBuffers = {};
  if (currentPresetCategory === 'user') {
    samplePool[slotIdx].name = cropState.fileName.split('.')[0].slice(0, 10);
  }
  cropState.btnEl.innerHTML = '✓';
  cropState.btnEl.title = cropState.fileName;
  cropState.btnEl.classList.add('has-sample');
  document.getElementById('crop-modal').classList.remove('show');
  showToast(samplePool[slotIdx].name + ' cropped & loaded!', '');
}

function cancelCrop() {
  document.getElementById('crop-modal').classList.remove('show');
  cropState.buffer = null;
}

// 将 AudioBuffer 编码为标准 WAV 格式（PCM 16-bit）
// 将 AudioBuffer 编码为标准 WAV 格式（PCM 16-bit 立体声/单声道）
function audioBufferToWav(buffer) {
  const numOfChan = buffer.numberOfChannels;
  // 总大小 = 数据长度 + 44 字节文件头
  const length = buffer.length * numOfChan * 2 + 44;
  const arrayBuffer = new ArrayBuffer(length);
  const view = new DataView(arrayBuffer);
  const channels = [];
  let sample = 0;
  let offset = 0;
  let pos = 0;

  // 写入 WAV 文件头（44 字节标准头）
  setUint32(0x46464952); // "RIFF"
  setUint32(length - 8); // file length - 8
  setUint32(0x45564157); // "WAVE"
  setUint32(0x20746d66); // "fmt " chunk
  setUint32(16); // length = 16
  setUint16(1); // PCM (uncompressed)
  setUint16(numOfChan);
  setUint32(buffer.sampleRate);
  setUint32(buffer.sampleRate * 2 * numOfChan); // avg. bytes/sec
  setUint16(numOfChan * 2); // block-align
  setUint16(16); // 16-bit (hardcoded in this demo)
  setUint32(0x61746164); // "data" - chunk
  setUint32(length - pos - 4); // chunk length

  // 写入交错采样数据（多声道轮流写入）
  for (let i = 0; i < buffer.numberOfChannels; i++) channels.push(buffer.getChannelData(i));
  while (pos < length) {
    for (let i = 0; i < numOfChan; i++) {
      sample = Math.max(-1, Math.min(1, channels[i][offset]));
      sample = (0.5 + sample < 0 ? sample * 32768 : sample * 32767)|0;
      view.setInt16(pos, sample, true);
      pos += 2;
    }
    offset++;
  }
  return arrayBuffer;

  function setUint16(data) { view.setUint16(pos, data, true); pos += 2; }
  function setUint32(data) { view.setUint32(pos, data, true); pos += 4; }
}

// ArrayBuffer 转为 Base64 字符串，用于 localStorage 存储用户采样

// 将 AudioBuffer 数据复制到另一个 AudioContext（用于 OfflineAudioContext 导出）
function cloneAudioBuffer(src, dstCtx) {
  const dst = dstCtx.createBuffer(src.numberOfChannels, src.length, src.sampleRate);
  for (let c = 0; c < src.numberOfChannels; c++) {
    dst.copyToChannel(src.getChannelData(c), c);
  }
  return dst;
}
function arrayBufferToBase64(buffer) {
  let binary = '';
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

const USER_PRESET_KEY = 'hakimi_user_presets';

// 将用户上传的自定义采样编码为 Base64 并保存到 localStorage
function saveUserPresets() {
  const presets = [];
  for (let i = 0; i < SAMPLE_SLOTS; i++) {
    const s = samplePool[i];
    if (s.buffer && currentPresetCategory === 'user') {
      const wav = audioBufferToWav(s.buffer);
      presets.push({ idx: i, name: s.name, base64: arrayBufferToBase64(wav) });
    }
  }
  localStorage.setItem(USER_PRESET_KEY, JSON.stringify(presets));
}

async function loadUserPresets() {
  const raw = localStorage.getItem(USER_PRESET_KEY);
  if (!raw) return;
  try {
    const presets = JSON.parse(raw);
    audio.init();
    for (const p of presets) {
      if (p.idx >= 0 && p.idx < SAMPLE_SLOTS) {
        try {
          const ab = base64ToArrayBuffer(p.base64);
          samplePool[p.idx].buffer = await audio.ctx.decodeAudioData(ab);
          samplePool[p.idx].pitchBuffers = {};
          samplePool[p.idx].name = p.name;
        } catch (e) { console.error('Failed to decode user preset', p.idx, e); }
      }
    }
  } catch (e) { console.error('Failed to load user presets', e); }
}

// ================================================================
//  用户采样预制管理：命名保存/加载/删除多组采样预制
// ================================================================
const SAMPLE_PRESETS_KEY = 'pawbeats_sample_presets';

// 获取所有采样预制列表
function getSamplePresetList() {
  try { return JSON.parse(localStorage.getItem(SAMPLE_PRESETS_KEY) || '[]'); }
  catch { return []; }
}

// 保存当前8个槽位的采样为一个命名预制
function doSaveSamplePreset() {
  // 检查是否有可保存的采样
  const hasBuffer = samplePool.some(s => s.buffer !== null);
  if (!hasBuffer) { showToast('当前没有可保存的采样', 'warn'); return; }
  
  const name = prompt('请输入预制名称：');
  if (!name || !name.trim()) { showToast('已取消', 'warn'); return; }
  
  const list = getSamplePresetList();
  const presets = [];
  
  for (let i = 0; i < SAMPLE_SLOTS; i++) {
    const s = samplePool[i];
    if (s.buffer) {
      const wav = audioBufferToWav(s.buffer);
      presets.push({ idx: i, name: s.name, color: s.color, base64: arrayBufferToBase64(wav) });
    }
  }
  
  const now = new Date();
  const timeStr = now.getFullYear() + '-' + String(now.getMonth()+1).padStart(2,'0') + '-' + String(now.getDate()).padStart(2,'0') + ' ' + String(now.getHours()).padStart(2,'0') + ':' + String(now.getMinutes()).padStart(2,'0');
  
  // 移除同名预制
  const filtered = list.filter(p => p.name !== name.trim());
  filtered.push({ name: name.trim(), time: timeStr, presets: presets });
  
  localStorage.setItem(SAMPLE_PRESETS_KEY, JSON.stringify(filtered));
  showToast('预制 "' + name.trim() + '" 已保存', '');
  renderSamplePresetSelect();
  // 选中刚保存的预制
  const sel = document.getElementById('sample-preset-select');
  if (sel) sel.value = name.trim();
}

// 加载选中的采样预制
async function loadSamplePreset(name) {
  if (!name) return;
  const list = getSamplePresetList();
  const preset = list.find(p => p.name === name);
  if (!preset) { showToast('预制不存在', 'err'); return; }
  
  audio.init();
  // 先清空所有槽位
  for (let i = 0; i < SAMPLE_SLOTS; i++) {
    samplePool[i].buffer = null;
    samplePool[i].pitchBuffers = {};
  }
  
  for (const s of preset.presets) {
    if (s.idx >= 0 && s.idx < SAMPLE_SLOTS) {
      try {
        const ab = base64ToArrayBuffer(s.base64);
        samplePool[s.idx].buffer = await audio.ctx.decodeAudioData(ab);
        samplePool[s.idx].pitchBuffers = {};
        samplePool[s.idx].name = s.name;
        if (s.color) samplePool[s.idx].color = s.color;
      } catch (e) { console.error('Failed to decode sample preset', s.idx, e); }
    }
  }
  currentPresetCategory = 'user';
  renderPresetBar();
  renderSamples();
  renderSeq();
  showToast('已加载预制: ' + name, '');
}

// 删除选中的采样预制（从下拉框删除）
function deleteSamplePreset(name) {
  if (!confirm('确定删除预制 "' + name + '" 吗？')) return;
  let list = getSamplePresetList();
  list = list.filter(p => p.name !== name);
  localStorage.setItem(SAMPLE_PRESETS_KEY, JSON.stringify(list));
  renderSamplePresetSelect();
  showToast('已删除预制: ' + name, '');
}

// 从工具栏按钮触发的删除（读取下拉框当前选中值）
function doDeleteSamplePreset() {
  const sel = document.getElementById('sample-preset-select');
  const name = sel ? sel.value : '';
  if (!name) { showToast('请先从下拉框选择要删除的预制', 'warn'); return; }
  deleteSamplePreset(name);
}

// 渲染预制下拉框选项（渲染到顶部工具栏的下拉框中）
function renderSamplePresetSelect() {
  const sel = document.getElementById('sample-preset-select');
  if (!sel) return;
  const list = getSamplePresetList();
  const currentVal = sel.value;
  sel.innerHTML = '<option value="">🎵 预制...</option>';
  // 按时间倒序排列（最新的在前）
  const sorted = [...list].sort((a, b) => b.time.localeCompare(a.time));
  for (const p of sorted) {
    const opt = document.createElement('option');
    opt.value = p.name;
    opt.textContent = p.name + ' (' + p.time + ')';
    sel.appendChild(opt);
  }
  // 恢复之前选中的值
  if (list.find(p => p.name === currentVal)) sel.value = currentVal;
}

// ================================================================
//  音序器播放控制：播放/停止、Tick 调度、粒子特效
// ================================================================
// 切换播放/暂停状态
function togglePlay() {
  state.isPlaying ? stopPlay() : startPlay();
}

async function startPlay() {
  audio.init();
  if (audio.ctx && audio.ctx.state === 'suspended') await audio.ctx.resume();
  state.isPlaying = true;
  state.currentStep = -1;
  document.getElementById('btn-play').textContent = '⏸';
  tick();
}

// 在指定元素位置产生彩色粒子爆炸特效
function spawnParticles(el, color) {
  const rect = el.getBoundingClientRect();
  const cx = rect.left + rect.width / 2;
  const cy = rect.top + rect.height / 2;
  for (let i = 0; i < 6; i++) {
    const p = document.createElement('div');
    p.className = 'particle';
    p.style.background = color;
    p.style.left = cx + 'px';
    p.style.top = cy + 'px';
    const angle = Math.random() * Math.PI * 2;
    const dist = 20 + Math.random() * 40;
    p.style.setProperty('--dx', Math.cos(angle) * dist + 'px');
    p.style.setProperty('--dy', Math.sin(angle) * dist + 'px');
    document.body.appendChild(p);
    setTimeout(() => p.remove(), 600);
  }
}

// 音序器核心 Tick：按 BPM 调度播放当前步进的音符与鼓点
function tick() {
  if (!state.isPlaying) return;
  // 根据方向前进或后退一步，16步循环
  state.currentStep = state.reverse ? (state.currentStep - 1 + COLS) % COLS : (state.currentStep + 1) % COLS;

  // 先更新视觉高亮（确保进度条与声音同步，视觉不滞后）
  updatePlayCol();

  // 更新节拍转盘角度：每步旋转 360/16 = 22.5 度
  const arm = document.getElementById('spinner-arm');
  if (arm) {
    const angle = (state.currentStep / COLS) * 360;
    arm.style.transform = `rotate(${angle}deg)`;
  }

  // 遍历所有旋律行，播放当前步进中激活的音符
  for (let r = 0; r < NOTE_ROWS; r++) {
    if (soloMode && !soloMelody.has(r)) continue; // 独奏模式：跳过非独奏行
    if (muteState.melody[r]) continue; // 静音行跳过
    const slotIdx = noteGrid[r][state.currentStep];
    if (slotIdx !== null) {
      const vel = velGrid[r][state.currentStep] || 2;
      audio.playMelody(slotIdx, NOTES[r].freq, vel);
      // 若开启粒子特效，在对应格子上产生彩色粒子
      if (state.particles) {
        const cell = document.querySelector('.step-cell[data-row="' + r + '"][data-col="' + state.currentStep + '"]');
        if (cell) spawnParticles(cell, samplePool[slotIdx]?.color || '#fff');
      }
    }
  }
  // 遍历所有鼓轨道，播放当前步进中激活的鼓点
  for (let r = 0; r < DRUM_ROWS; r++) {
    if (soloMode && !soloDrums.has(r)) continue;
    if (muteState.drums[r]) continue;
    if (drumGrid[r][state.currentStep]) {
      const vel = drumVelGrid[r][state.currentStep] || 2;
      audio.playDrum(DRUMS[r].name, vel);
      if (state.particles) {
        const cell = document.querySelector('.drum-cell[data-row="' + r + '"][data-col="' + state.currentStep + '"]');
        if (cell) spawnParticles(cell, DRUMS[r].color);
      }
    }
  }

  // 计算下一步的延迟时间（毫秒），包含 Swing 偏移
  const baseDelay = (60 / state.bpm) * 1000 / 4; // 每步 = 1/4拍
  const isSwingStep = state.reverse ? (state.currentStep % 2 === 0) : (state.currentStep % 2 === 1);
  const delay = baseDelay * (1 + (isSwingStep ? state.swing / 100 : 0));
  // 使用 setTimeout 递归调用，形成精确节拍调度
  state.timer = setTimeout(tick, delay);
}

// 停止播放并重置状态
function stopPlay() {
  state.isPlaying = false;
  if (state.timer) { clearTimeout(state.timer); state.timer = null; }
  state.currentStep = -1;
  _prevPlayCol = -1; // 重置列高亮缓存
  document.getElementById('btn-play').textContent = '▶';
  renderAll();
}

function doStop() { stopPlay(); }

// ================================================================
//  音频可视化：频谱柱状图 / 波形图实时绘制
// ================================================================
// 可视化器类：基于 AnalyserNode 绘制频谱或波形
class Visualizer {
  constructor(id) {
    this.cvs = document.getElementById(id);
    this.ctx = this.cvs.getContext('2d');
    this.running = false; this.mode = 'spectrum'; this.resize();
  }
  resize() {
    const r = this.cvs.parentElement.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    this.cvs.width = r.width * dpr; this.cvs.height = r.height * dpr;
    this.ctx.scale(dpr, dpr);
    this.w = r.width; this.h = r.height;
  }
  start() { this.running = true; this.loop(); }
  stop() { this.running = false; }
  setMode(m) { this.mode = m; }
  // 主循环：每帧从分析器获取数据并绘制
  loop() {
    if (!this.running) return;
    const a = audio.getAnalyser();
    if (a) {
      if (this.mode === 'waveform') {
        // 时域数据：绘制波形图
        const data = new Uint8Array(a.fftSize);
        a.getByteTimeDomainData(data);
        this.drawWaveform(data);
      } else {
        // 频域数据：绘制频谱柱状图
        const data = new Uint8Array(a.frequencyBinCount);
        a.getByteFrequencyData(data);
        this.draw(data);
      }
    } else { this.ctx.clearRect(0,0,this.w,this.h); }
    // 下一帧继续循环
    requestAnimationFrame(() => this.loop());
  }
  // 绘制频谱柱状图：32 个条形，颜色随主题变化
  draw(data) {
    const ctx = this.ctx, w = this.w, h = this.h;
    const theme = document.documentElement.dataset.theme || 'cyber';
    // 各主题的清屏颜色（半透明，产生拖尾效果）
    const clearColors = { cyber: 'rgba(5,5,16,0.3)', retro: 'rgba(0,15,0,0.3)', light: 'rgba(220,220,230,0.3)', wire: 'rgba(15,5,15,0.3)', ocean: 'rgba(200,220,230,0.3)' };
    // 各主题的色相起始偏移
    const hueOffsets = { cyber: 180, retro: 100, light: 200, wire: 300, ocean: 190 };
    // 半透明覆盖，让旧帧逐渐淡出形成拖尾
    ctx.fillStyle = clearColors[theme] || 'rgba(5,5,16,0.3)';
    ctx.fillRect(0, 0, w, h);
    const n = 32, bw = (w - (n+1)*2) / n, mh = h - 6;
    for (let i = 0; i < n; i++) {
      const v = data[Math.floor(i * data.length / n)] || 0;
      const bh = Math.max(2, (v/255) * mh);
      const hue = (hueOffsets[theme] || 180) + (i/n) * 160;
      ctx.fillStyle = `hsl(${hue},80%,60%)`;
      ctx.shadowColor = `hsl(${hue},80%,60%)`;
      ctx.shadowBlur = 6;
      ctx.fillRect(2 + i*(bw+2), h - 3 - bh, bw, bh);
    }
    ctx.shadowBlur = 0;
  }
  drawWaveform(data) {
    const ctx = this.ctx, w = this.w, h = this.h;
    const theme = document.documentElement.dataset.theme || 'cyber';
    const clearColors = { cyber: 'rgba(5,5,16,0.3)', retro: 'rgba(0,15,0,0.3)', light: 'rgba(220,220,230,0.3)', wire: 'rgba(15,5,15,0.3)', ocean: 'rgba(200,220,230,0.3)' };
    ctx.fillStyle = clearColors[theme] || 'rgba(5,5,16,0.3)';
    ctx.fillRect(0, 0, w, h);
    const accent = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#00e5ff';
    ctx.lineWidth = 2;
    ctx.strokeStyle = accent;
    ctx.beginPath();
    const slice = w / data.length;
    for (let i = 0; i < data.length; i++) {
      const v = data[i] / 255;
      const y = (v * 0.8 + 0.1) * h;
      if (i === 0) ctx.moveTo(0, y);
      else ctx.lineTo(i * slice, y);
    }
    ctx.stroke();
  }
}
const viz = new Visualizer('viz-canvas');

// ================================================================
//  控件初始化：滑块、下拉框事件绑定
// ================================================================
// 初始化所有控件的事件监听器
function initControls() {
  const bpm = document.getElementById('bpm-range');
  const vol = document.getElementById('vol-range');
  const wave = document.getElementById('wave-select');
  const swing = document.getElementById('swing-range');
  bpm.oninput = () => { state.bpm = +bpm.value; document.getElementById('bpm-val').textContent = state.bpm; };
  vol.oninput = () => { document.getElementById('vol-val').textContent = vol.value; audio.setVolume(vol.value/100); };
  wave.onchange = () => { state.wave = wave.value; };
  if (swing) {
    swing.oninput = () => {
      state.swing = +swing.value;
      const el = document.getElementById('swing-val');
      if (el) el.textContent = state.swing + '%';
    };
  }
  updateParticleBtn(); updateReverseBtn(); updateReverbBtn(); updateDelayBtn(); updateVizBtn();
}

// ================================================================
//  工程管理：命名保存/加载/删除多个工程
// ================================================================
const PROJECTS_KEY = 'pawbeats_projects';

// 获取所有已保存的工程列表（不含数据，仅名称和时间戳）
function getProjectList() {
  try {
    return JSON.parse(localStorage.getItem(PROJECTS_KEY) || '[]');
  } catch { return []; }
}

// 更新工程列表元数据
function updateProjectList(list) {
  localStorage.setItem(PROJECTS_KEY, JSON.stringify(list));
}

// 收集当前工程数据
function collectProjectData() {
  return {
    bpm: state.bpm, vol: Math.round(state.volume*100), wave: state.wave, swing: state.swing, particles: state.particles,
    reverse: state.reverse, reverb: state.reverb, delay: state.delay,
    notes: noteGrid, drums: drumGrid, vel: velGrid, drumVel: drumVelGrid,
    scale: currentScale
  };
}

// 应用工程数据到当前状态
function applyProjectData(d) {
  state.bpm = d.bpm || 128; state.volume = (d.vol || 80)/100; state.wave = d.wave || 'triangle'; state.swing = d.swing || 0; state.particles = d.particles !== undefined ? d.particles : true;
  state.reverse = d.reverse || false; state.reverb = d.reverb || false; state.delay = d.delay || false;
  if (d.notes && d.notes.length === NOTE_ROWS) noteGrid = d.notes;
  if (d.drums && d.drums.length === DRUM_ROWS) drumGrid = d.drums;
  if (d.vel && d.vel.length === NOTE_ROWS) velGrid = d.vel;
  if (d.drumVel && d.drumVel.length === DRUM_ROWS) drumVelGrid = d.drumVel;
  if (d.scale) { currentScale = d.scale; const scaleEl = document.getElementById('scale-select'); if (scaleEl) scaleEl.value = d.scale; }
  document.getElementById('bpm-range').value = state.bpm;
  document.getElementById('bpm-val').textContent = state.bpm;
  document.getElementById('vol-range').value = Math.round(state.volume*100);
  document.getElementById('vol-val').textContent = Math.round(state.volume*100);
  document.getElementById('wave-select').value = state.wave;
  const swingEl = document.getElementById('swing-range');
  if (swingEl) { swingEl.value = state.swing; document.getElementById('swing-val').textContent = state.swing + '%'; }
  updateParticleBtn(); updateReverseBtn(); updateReverbBtn(); updateDelayBtn(); updateVizBtn();
  audio.setVolume(state.volume);
  if (audio.initialized) { audio.toggleReverb(state.reverb); audio.toggleDelay(state.delay); }
  renderAll();
}

// 保存工程：若下拉框已选中某个工程则直接覆盖，否则弹窗输入新名称
function doSaveProject() {
  const sel = document.getElementById('project-select');
  const currentName = sel ? sel.value.trim() : '';
  const data = collectProjectData();
  const now = new Date();
  const timeStr = now.getFullYear() + '-' + String(now.getMonth()+1).padStart(2,'0') + '-' + String(now.getDate()).padStart(2,'0') + ' ' + String(now.getHours()).padStart(2,'0') + ':' + String(now.getMinutes()).padStart(2,'0');

  if (currentName) {
    // 已有选中的工程，直接覆盖保存
    const list = getProjectList();
    const proj = list.find(p => p.name === currentName);
    if (proj) {
      proj.time = timeStr;
      proj.data = data;
      localStorage.setItem(PROJECTS_KEY, JSON.stringify(list));
      renderProjectSelect();
      if (sel) sel.value = currentName;
      showToast('工程 "' + currentName + '" 已保存', '');
      return;
    }
  }

  // 没有选中工程，弹窗输入新名称
  const name = prompt('请输入工程名称：');
  if (!name || !name.trim()) { showToast('已取消保存', 'warn'); return; }
  const list = getProjectList();
  const existing = list.find(p => p.name === name.trim());

  if (existing) {
    if (!confirm('工程 "' + name.trim() + '" 已存在，是否覆盖？')) { showToast('已取消保存', 'warn'); return; }
    existing.time = timeStr;
    existing.data = data;
  } else {
    list.push({ name: name.trim(), time: timeStr, data: data });
  }

  localStorage.setItem(PROJECTS_KEY, JSON.stringify(list));
  renderProjectSelect();
  const sel2 = document.getElementById('project-select');
  if (sel2) sel2.value = name.trim();
  showToast('工程 "' + name.trim() + '" 已保存', '');
}

// 加载选中的工程
function loadSelectedProject(name) {
  if (!name) return;
  const list = getProjectList();
  const proj = list.find(p => p.name === name);
  if (!proj) { showToast('工程不存在', 'err'); return; }
  try {
    stopPlay();
    applyProjectData(proj.data);
    showToast('已加载: ' + name, '');
  } catch(e) { showToast('加载失败', 'err'); }
}

// 从下拉框触发的加载（保留原来的 doLoad 用键盘快捷键 'l' 调用）
function doLoadProject() {
  const sel = document.getElementById('project-select');
  if (sel && sel.value) {
    loadSelectedProject(sel.value);
  } else {
    showToast('请先从下拉框选择一个工程', 'warn');
  }
}

// 删除选中的工程
function doDeleteProject() {
  const sel = document.getElementById('project-select');
  const name = sel ? sel.value : '';
  if (!name) { showToast('请先从下拉框选择要删除的工程', 'warn'); return; }
  if (!confirm('确定删除工程 "' + name + '" 吗？此操作不可撤销。')) return;
  let list = getProjectList();
  list = list.filter(p => p.name !== name);
  localStorage.setItem(PROJECTS_KEY, JSON.stringify(list));
  renderProjectSelect();
  showToast('已删除: ' + name, '');
}

// 渲染工程下拉框选项
function renderProjectSelect() {
  const sel = document.getElementById('project-select');
  if (!sel) return;
  const list = getProjectList();
  const currentVal = sel.value;
  sel.innerHTML = '<option value="">选择工程...</option>';
  // 按时间倒序排列（最新的在前）
  const sorted = [...list].sort((a, b) => b.time.localeCompare(a.time));
  for (const p of sorted) {
    const opt = document.createElement('option');
    opt.value = p.name;
    opt.textContent = p.name + ' (' + p.time + ')';
    sel.appendChild(opt);
  }
  // 恢复之前选中的值
  if (list.find(p => p.name === currentVal)) sel.value = currentVal;
}

// 自动保存当前工程到 localStorage（快速保存，不弹窗）
function doSave() {
  const data = collectProjectData();
  localStorage.setItem('seq_pattern_v3', JSON.stringify(data));
  showToast('快速保存成功', '');
}

// 从 localStorage 读取并恢复 Pattern（兼容旧数据）
function doLoad() {
  const raw = localStorage.getItem('seq_pattern_v3');
  if (!raw) { showToast('没有快速保存的数据', 'warn'); return; }
  try {
    const d = JSON.parse(raw);
    stopPlay();
    applyProjectData(d);
    showToast('已加载快速保存', '');
  } catch(e) { showToast('加载失败', 'err'); }
}

// 清空所有网格数据
function doClear() {
  showConfirm('Clear Pattern', 'Clear all notes and drums?', () => {
    pushUndo();
    for (let r = 0; r < NOTE_ROWS; r++) noteGrid[r].fill(null);
    for (let r = 0; r < DRUM_ROWS; r++) drumGrid[r].fill(false);
    for (let r = 0; r < NOTE_ROWS; r++) velGrid[r].fill(2);
    for (let r = 0; r < DRUM_ROWS; r++) drumVelGrid[r].fill(2);
    stopPlay(); renderAll();
    showToast('Cleared', '');
  });
}

// 随机生成旋律与鼓点 Pattern：只在选中音阶内生成音符
function doRandom() {
  stopPlay();
  pushUndo();
  const scaleRows = getScaleRows();
  for (let r = 0; r < NOTE_ROWS; r++) {
    const inScale = scaleRows.includes(r);
    for (let c = 0; c < COLS; c++) {
      if (currentScale === 'chromatic' || inScale) {
        noteGrid[r][c] = Math.random() < 0.06 ? Math.floor(Math.random() * SAMPLE_SLOTS) : null;
        velGrid[r][c] = noteGrid[r][c] !== null ? [1,2,2,2,3][Math.floor(Math.random()*5)] : 2;
      } else {
        noteGrid[r][c] = null;
        velGrid[r][c] = 2;
      }
    }
  }
  for (let r = 0; r < DRUM_ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      drumGrid[r][c] = Math.random() < 0.15;
      drumVelGrid[r][c] = drumGrid[r][c] ? [1,2,2,2,3][Math.floor(Math.random()*5)] : 2;
    }
  }
  renderAll();
  showToast('Random pattern generated', '');
}

// =====================================================================
//  PRESETS
// =====================================================================
const PRESETS = {
  house: {
    notes: [{r:12,c:0},{r:12,c:4},{r:12,c:8},{r:12,c:12},{r:9,c:2},{r:9,c:6},{r:9,c:10},{r:9,c:14}],
    drums: [
      [1,0,0,0,0,0,1,0,1,0,0,0,0,0,1,0],
      [0,0,0,0,1,0,0,0,0,0,0,0,1,0,0,0],
      [1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0],
      [0,0,0,0,1,0,0,0,0,0,0,0,1,0,0,0],
    ]
  },
  techno: {
    notes: [{r:12,c:0},{r:12,c:2},{r:12,c:4},{r:12,c:6},{r:12,c:8},{r:12,c:10},{r:12,c:12},{r:12,c:14}],
    drums: [
      [1,0,0,0,1,0,0,0,1,0,0,0,1,0,0,0],
      [0,0,0,0,1,0,0,0,0,0,0,0,1,0,0,0],
      [1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1],
      [0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],
    ]
  },
  trap: {
    notes: [{r:5,c:0},{r:5,c:2},{r:5,c:4},{r:5,c:6},{r:5,c:8}],
    drums: [
      [1,0,0,0,0,0,0,0,0,0,1,0,1,0,0,0],
      [0,0,0,0,1,0,0,0,0,0,0,0,1,0,0,0],
      [1,0,1,1,0,1,1,0,1,0,1,1,0,1,1,0],
      [0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],
    ]
  },
  bossa: {
    notes: [{r:10,c:0},{r:10,c:4},{r:10,c:8},{r:10,c:12},{r:7,c:2},{r:7,c:6},{r:7,c:10},{r:7,c:14}],
    drums: [
      [1,0,0,0,0,0,1,0,0,0,0,0,0,0,1,0],
      [0,0,0,0,0,0,0,0,1,0,0,0,0,0,0,0],
      [1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0],
      [0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],
    ]
  }
};

// 切换粒子特效开关
function toggleParticles() {
  state.particles = !state.particles;
  updateParticleBtn();
}

function updateParticleBtn() {
  const btn = document.getElementById('btn-particles');
  if (!btn) return;
  btn.classList.toggle('on', state.particles);
  btn.style.opacity = state.particles ? 1 : 0.4;
  btn.title = state.particles ? 'Particles ON' : 'Particles OFF';
}

// 切换反向播放模式
function toggleReverse() {
  state.reverse = !state.reverse;
  updateReverseBtn();
}

function updateReverseBtn() {
  const btn = document.getElementById('btn-reverse');
  if (!btn) return;
  btn.classList.toggle('on', state.reverse);
  btn.style.opacity = state.reverse ? 1 : 0.4;
  btn.title = state.reverse ? 'Reverse ON' : 'Reverse OFF';
}

// 切换混响效果开关
function toggleReverb() {
  state.reverb = !state.reverb;
  if (audio.initialized) audio.toggleReverb(state.reverb);
  updateReverbBtn();
}

function updateReverbBtn() {
  const btn = document.getElementById('btn-reverb');
  if (!btn) return;
  btn.classList.toggle('on', state.reverb);
  btn.style.opacity = state.reverb ? 1 : 0.4;
  btn.title = state.reverb ? 'Reverb ON' : 'Reverb OFF';
}

// 切换延迟效果开关
function toggleDelay() {
  state.delay = !state.delay;
  if (audio.initialized) audio.toggleDelay(state.delay);
  updateDelayBtn();
}

function updateDelayBtn() {
  const btn = document.getElementById('btn-delay');
  if (!btn) return;
  btn.classList.toggle('on', state.delay);
  btn.style.opacity = state.delay ? 1 : 0.4;
  btn.title = state.delay ? 'Delay ON' : 'Delay OFF';
}

// 切换可视化模式（频谱 / 波形）
function toggleVizMode() {
  viz.mode = viz.mode === 'spectrum' ? 'waveform' : 'spectrum';
  updateVizBtn();
}

function updateVizBtn() {
  const btn = document.getElementById('btn-viz');
  if (!btn) return;
  btn.textContent = viz.mode === 'spectrum' ? '频谱' : '波形';
}

// === Copy/Paste ===
// 复制选中的 Pattern 到剪贴板
function doCopy() {
  pushUndo();
  clipboard = {
    noteGrid: noteGrid.map(r => [...r]),
    drumGrid: drumGrid.map(r => [...r]),
    velGrid: velGrid.map(r => [...r]),
    drumVelGrid: drumVelGrid.map(r => [...r]),
  };
  showToast('Pattern copied', '');
}

// 从剪贴板粘贴 Pattern
function doPaste() {
  if (!clipboard) { showToast('Nothing to paste', 'warn'); return; }
  pushUndo();
  for (let r = 0; r < NOTE_ROWS && r < clipboard.noteGrid.length; r++)
    noteGrid[r] = [...clipboard.noteGrid[r]];
  for (let r = 0; r < DRUM_ROWS && r < clipboard.drumGrid.length; r++)
    drumGrid[r] = [...clipboard.drumGrid[r]];
  for (let r = 0; r < NOTE_ROWS && r < clipboard.velGrid.length; r++)
    velGrid[r] = [...clipboard.velGrid[r]];
  for (let r = 0; r < DRUM_ROWS && r < clipboard.drumVelGrid.length; r++)
    drumVelGrid[r] = [...clipboard.drumVelGrid[r]];
  renderAll();
  showToast('Pattern pasted', '');
}

// === Tap Tempo ===
// Tap Tempo：通过多次点击计算 BPM
function tapTempo() {
  const now = Date.now();
  tapTimes.push(now);
  if (tapTimes.length > 5) tapTimes.shift();
  if (tapTimes.length >= 2) {
    const intervals = [];
    for (let i = 1; i < tapTimes.length; i++) {
      intervals.push(tapTimes[i] - tapTimes[i-1]);
    }
    const avg = intervals.reduce((a,b)=>a+b,0) / intervals.length;
    const bpm = Math.round(60000 / avg);
    if (bpm >= 60 && bpm <= 200) {
      state.bpm = bpm;
      document.getElementById('bpm-range').value = bpm;
      document.getElementById('bpm-val').textContent = bpm;
      showToast('BPM: ' + bpm, '');
    }
  }
  clearTimeout(tapTempo._timer);
  tapTempo._timer = setTimeout(() => { tapTimes = []; }, 3000);
}

// === Scale Lock ===
// 切换音阶锁定，过滤可用音符
function changeScale(scaleId) {
  currentScale = scaleId;
  renderAll();
  showToast('音阶: ' + SCALES[scaleId].name, '');
}

// === Dynamics Compressor ===
// 切换动态压缩器开关
function toggleCompressor() {
  if (!audio.compressor) return;
  const btn = document.getElementById('btn-comp');
  if (audio.compressor.threshold.value === -Infinity) {
    audio.compressor.threshold.value = -24;
    btn.classList.add('on');
    btn.style.opacity = 1;
    showToast('压缩器开启', '');
  } else {
    audio.compressor.threshold.value = -Infinity;
    btn.classList.remove('on');
    btn.style.opacity = 0.4;
    showToast('压缩器关闭', '');
  }
}

function randomMelodyRow(r) {
  if (state.isPlaying) return;
  pushUndo();
  for (let c = 0; c < COLS; c++) {
    noteGrid[r][c] = Math.random() < 0.1 ? Math.floor(Math.random() * SAMPLE_SLOTS) : null;
    velGrid[r][c] = noteGrid[r][c] !== null ? [1,2,2,2,3][Math.floor(Math.random()*5)] : 2;
  }
  renderSeq();
  showToast('Melody row randomized', '');
}

function randomDrumRow(r) {
  if (state.isPlaying) return;
  pushUndo();
  for (let c = 0; c < COLS; c++) {
    drumGrid[r][c] = Math.random() < 0.2;
    drumVelGrid[r][c] = drumGrid[r][c] ? [1,2,2,2,3][Math.floor(Math.random()*5)] : 2;
  }
  renderDrums();
  showToast('Drum row randomized', '');
}

// ================================================================
//  WAV 音频导出
// ================================================================
// 使用 OfflineAudioContext 渲染音频并导出为 WAV 格式
async function exportWav() {
  const wasPlaying = state.isPlaying;
  if (wasPlaying) stopPlay();

  audio.init();
  const sampleRate = audio.ctx.sampleRate;
  const stepDurSec = (60 / state.bpm) / 4; // 每步秒数（1/4拍）
  const totalDuration = stepDurSec * COLS; // 16步总时长
  const totalSamples = Math.ceil(sampleRate * totalDuration);

  // 创建离线音频上下文（2声道）
  const offlineCtx = new OfflineAudioContext(2, totalSamples, sampleRate);

  // 创建主增益节点
  const masterGain = offlineCtx.createGain();
  masterGain.gain.value = state.volume;

  // 创建压缩器
  const compressor = offlineCtx.createDynamicsCompressor();
  compressor.threshold.value = -24;
  compressor.knee.value = 30;
  compressor.ratio.value = 12;
  compressor.attack.value = 0.003;
  compressor.release.value = 0.25;

  masterGain.connect(compressor);
  compressor.connect(offlineCtx.destination);

  // 调度播放 16 步
  for (let step = 0; step < COLS; step++) {
    const currentStep = state.reverse ? (COLS - 1 - step) : step;
    const time = step * stepDurSec;
    // Swing 偏移
    const isSwingStep = state.reverse ? (currentStep % 2 === 0) : (currentStep % 2 === 1);
    const swingOffset = isSwingStep ? stepDurSec * (state.swing / 100) : 0;
    const noteTime = time + swingOffset;

    // 旋律
    for (let r = 0; r < NOTE_ROWS; r++) {
      const slotIdx = noteGrid[r][currentStep];
      if (slotIdx === null) continue;
      const vel = velGrid[r][currentStep] || 2;
      const mult = vel === 1 ? 0.5 : vel === 2 ? 0.75 : 1.0;
      const sample = samplePool[slotIdx];

      if (sample && sample.buffer) {
        // 采样播放（变调）
        const rate = NOTES[r].freq / BASE_FREQ;
        let buf = sample.pitchBuffers[rate];
        if (!buf) buf = sample.buffer;
        const cloned = cloneAudioBuffer(buf, offlineCtx);
        const src = offlineCtx.createBufferSource();
        src.buffer = cloned;
        const g = offlineCtx.createGain();
        g.gain.value = state.volume * 0.9 * mult;
        src.connect(g); g.connect(masterGain);
        src.start(noteTime);
      } else {
        // 合成器
        const osc = offlineCtx.createOscillator();
        osc.type = state.wave;
        osc.frequency.value = NOTES[r].freq;
        const g = offlineCtx.createGain();
        g.gain.setValueAtTime(0, noteTime);
        g.gain.linearRampToValueAtTime(0.25 * mult, noteTime + 0.01);
        g.gain.exponentialRampToValueAtTime(0.001, noteTime + 0.28);
        osc.connect(g); g.connect(masterGain);
        osc.start(noteTime);
        osc.stop(noteTime + 0.3);
      }
    }

    // 鼓
    for (let r = 0; r < DRUM_ROWS; r++) {
      if (!drumGrid[r][currentStep]) continue;
      const vel = drumVelGrid[r][currentStep] || 2;
      const mult = vel === 1 ? 0.4 : vel === 3 ? 1.3 : 0.9;
      const name = DRUMS[r].name;

      // 优先使用用户上传的鼓采样
      const drumBuf = audio.drumSamples[name];
      if (drumBuf) {
        const cloned = cloneAudioBuffer(drumBuf, offlineCtx);
        const src = offlineCtx.createBufferSource();
        src.buffer = cloned;
        const g = offlineCtx.createGain();
        g.gain.value = state.volume * 0.9 * mult;
        src.connect(g); g.connect(masterGain);
        src.start(noteTime);
        continue;
      }

      // 程序合成鼓声
      const p = (DRUM_SYNTHS[currentDrumPreset] || DRUM_SYNTHS.classic)[name];
      if (!p) continue;

      if (name === 'Kick') {
        const o = offlineCtx.createOscillator();
        o.type = p.type || 'sine';
        o.frequency.setValueAtTime(p.freq, noteTime);
        o.frequency.exponentialRampToValueAtTime(Math.max(p.endFreq, 0.01), noteTime + p.dur);
        const g = offlineCtx.createGain();
        g.gain.setValueAtTime(p.gain * mult, noteTime);
        g.gain.exponentialRampToValueAtTime(0.001, noteTime + p.dur);
        o.connect(g); g.connect(masterGain);
        o.start(noteTime); o.stop(noteTime + p.dur);
      } else if (name === 'Snare') {
        const noise = offlineCtx.createBufferSource();
        const buf = offlineCtx.createBuffer(1, Math.floor(sampleRate * p.noiseDur), sampleRate);
        const data = buf.getChannelData(0);
        for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
        noise.buffer = buf;
        const filt = offlineCtx.createBiquadFilter();
        filt.type = p.noiseFilt || 'highpass';
        filt.frequency.value = p.noiseFreq || 1500;
        const g = offlineCtx.createGain();
        g.gain.setValueAtTime(p.noiseGain * mult, noteTime);
        g.gain.exponentialRampToValueAtTime(0.001, noteTime + p.noiseDur);
        noise.connect(filt); filt.connect(g); g.connect(masterGain);
        noise.start(noteTime);
        if (p.toneType) {
          const o = offlineCtx.createOscillator();
          o.type = p.toneType; o.frequency.value = p.toneFreq;
          const g2 = offlineCtx.createGain();
          g2.gain.setValueAtTime(p.toneGain * mult, noteTime);
          g2.gain.exponentialRampToValueAtTime(0.001, noteTime + p.toneDur);
          o.connect(g2); g2.connect(masterGain);
          o.start(noteTime); o.stop(noteTime + p.toneDur);
        }
      } else if (name === 'HiHat') {
        const noise = offlineCtx.createBufferSource();
        const buf = offlineCtx.createBuffer(1, Math.floor(sampleRate * p.noiseDur), sampleRate);
        const data = buf.getChannelData(0);
        for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
        noise.buffer = buf;
        const filt = offlineCtx.createBiquadFilter();
        filt.type = p.filt || 'highpass';
        filt.frequency.value = p.freq || 8000;
        const g = offlineCtx.createGain();
        g.gain.setValueAtTime(p.noiseGain * mult, noteTime);
        g.gain.exponentialRampToValueAtTime(0.001, noteTime + p.dur);
        noise.connect(filt); filt.connect(g); g.connect(masterGain);
        noise.start(noteTime);
      } else if (name === 'Clap') {
        const layers = p.layers || 3;
        const gap = p.layerGap || 0.015;
        for (let i = 0; i < layers; i++) {
          const noise = offlineCtx.createBufferSource();
          const buf = offlineCtx.createBuffer(1, Math.floor(sampleRate * p.noiseDur), sampleRate);
          const data = buf.getChannelData(0);
          for (let j = 0; j < data.length; j++) data[j] = Math.random() * 2 - 1;
          noise.buffer = buf;
          const filt = offlineCtx.createBiquadFilter();
          filt.type = p.filt || 'highpass';
          filt.frequency.value = p.freq || 1500;
          const g = offlineCtx.createGain();
          const dt = noteTime + i * gap;
          g.gain.setValueAtTime(p.noiseGain * mult, dt);
          g.gain.exponentialRampToValueAtTime(0.001, dt + p.dur);
          noise.connect(filt); filt.connect(g); g.connect(masterGain);
          noise.start(dt);
        }
      }
    }
  }

  // 渲染音频
  showToast('正在渲染 WAV...', '');
  const renderedBuffer = await offlineCtx.startRendering();

  // 编码为 WAV
  const wavArray = audioBufferToWav(renderedBuffer);
  const blob = new Blob([wavArray], { type: 'audio/wav' });

  // 下载
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'pawbeats-' + Date.now() + '.wav';
  a.click();
  URL.revokeObjectURL(url);
  showToast('导出 WAV 完成!', '');
}

// 应用内置风格预设（House/Techno/Trap/Bossa Nova）
function applyPreset(name) {
  if (!name || !PRESETS[name]) return;
  stopPlay();
  pushUndo();
  for (let r = 0; r < NOTE_ROWS; r++) noteGrid[r].fill(null);
  for (let r = 0; r < DRUM_ROWS; r++) drumGrid[r].fill(false);
  for (let r = 0; r < NOTE_ROWS; r++) velGrid[r].fill(2);
  for (let r = 0; r < DRUM_ROWS; r++) drumVelGrid[r].fill(2);
  const p = PRESETS[name];
  for (const n of p.notes) {
    if (n.r < NOTE_ROWS && n.c < COLS) { noteGrid[n.r][n.c] = 0; }
  }
  for (let r = 0; r < DRUM_ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      drumGrid[r][c] = !!p.drums[r][c];
    }
  }
  renderAll();
  showToast('Preset: ' + name, '');
}

// 生成包含当前 Pattern 的分享链接
function shareLink() {
  const data = {
    bpm: state.bpm, vol: Math.round(state.volume*100), wave: state.wave,
    swing: state.swing, particles: state.particles, reverse: state.reverse,
    reverb: state.reverb, delay: state.delay,
    notes: noteGrid, drums: drumGrid, vel: velGrid, drumVel: drumVelGrid
  };
  try {
    const json = JSON.stringify(data);
    const b64 = btoa(encodeURIComponent(json));
    const url = location.origin + location.pathname + '#' + b64;
    navigator.clipboard.writeText(url).then(() => showToast('Link copied!', '')).catch(() => showToast('Copy failed', 'err'));
  } catch(e) { showToast('Share failed', 'err'); }
}

// 页面加载时检查 URL Hash，若存在则自动解析并恢复 Pattern
function loadFromHash() {
  if (!location.hash) return false;
  try {
    // Base64 解码 → URI 解码 → JSON 解析
    const json = decodeURIComponent(atob(location.hash.slice(1)));
    const d = JSON.parse(json);
    state.bpm = d.bpm || 128; state.volume = (d.vol || 80)/100; state.wave = d.wave || 'triangle';
    state.swing = d.swing || 0; state.particles = d.particles !== undefined ? d.particles : true;
    state.reverse = d.reverse || false; state.reverb = d.reverb || false; state.delay = d.delay || false;
    if (d.notes && d.notes.length === NOTE_ROWS) noteGrid = d.notes;
    if (d.drums && d.drums.length === DRUM_ROWS) drumGrid = d.drums;
    if (d.vel && d.vel.length === NOTE_ROWS) velGrid = d.vel;
    if (d.drumVel && d.drumVel.length === DRUM_ROWS) drumVelGrid = d.drumVel;
    document.getElementById('bpm-range').value = state.bpm;
    document.getElementById('bpm-val').textContent = state.bpm;
    document.getElementById('vol-range').value = Math.round(state.volume*100);
    document.getElementById('vol-val').textContent = Math.round(state.volume*100);
    document.getElementById('wave-select').value = state.wave;
    const swingEl = document.getElementById('swing-range');
    if (swingEl) { swingEl.value = state.swing; document.getElementById('swing-val').textContent = state.swing + '%'; }
    updateParticleBtn(); updateReverseBtn(); updateReverbBtn(); updateDelayBtn(); updateVizBtn();
    audio.setVolume(state.volume);
    if (audio.initialized) {
      audio.toggleReverb(state.reverb);
      audio.toggleDelay(state.delay);
    }
    renderAll();
    return true;
  } catch(e) { return false; }
}

// ================================================================
//  UI 工具函数：确认框、Toast 提示
// ================================================================
let modalCb = null;
// 显示确认对话框
function showConfirm(t, m, cb) {
  document.getElementById('modal-title').textContent = t;
  document.getElementById('modal-msg').textContent = m;
  document.getElementById('modal').classList.add('show');
  modalCb = cb;
  document.getElementById('modal-confirm').onclick = () => { if (modalCb) modalCb(); hideModal(); };
}
function hideModal() { document.getElementById('modal').classList.remove('show'); modalCb = null; }

let toastT = null;
// 显示 Toast 提示消息
function showToast(msg, type) {
  const el = document.getElementById('toast');
  el.textContent = msg; el.className = 'toast ' + type; el.classList.add('show');
  if (toastT) clearTimeout(toastT);
  toastT = setTimeout(() => el.classList.remove('show'), 2000);
}

// ================================================================
//  键盘快捷键：播放控制、编辑操作、功能快捷键
// ================================================================
document.addEventListener('keydown', e => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT' || e.target.tagName === 'TEXTAREA') return;

  // 播放控制
  if (e.code === 'Space') { e.preventDefault(); togglePlay(); return; }

  // Ctrl组合键
  if (e.ctrlKey || e.metaKey) {
    if (e.key === 'z') { e.preventDefault(); doUndo(); return; }
    if (e.key === 'y') { e.preventDefault(); doRedo(); return; }
    if (e.key === 'c' && !e.shiftKey) { e.preventDefault(); doCopy(); return; }
    if (e.key === 'v') { e.preventDefault(); doPaste(); return; }
    if (e.key === 's') { e.preventDefault(); doSave(); return; }
  }

  const key = e.key.toLowerCase();

  // 素材槽选择 1-8
  const num = parseInt(e.key);
  if (num >= 1 && num <= SAMPLE_SLOTS) {
    selectedSlot = num - 1;
    renderSamples();
    return;
  }

  // 功能快捷键
  switch (key) {
    case 's': doSave(); break;
    case 'l': doLoadProject(); break;
    case 'r': doRandom(); break;
    case 'x': doClear(); break;
    case 'e': exportWav(); break;
    case 'm': toggleParticles(); break;
    case 'b': toggleReverse(); break;
    case 'w': toggleReverb(); break;
    case 'q': toggleDelay(); break;
    case 't': tapTempo(); break;
    case 'p': toggleParticles(); break;
    case 'h': toggleHelpPanel(); break;
  }

  // Q-P 键在旋律网格对应列快速放置/移除音符
  // 用 [ ] 快速调节BPM
  if (e.key === '[' || e.key === '[') {
    state.bpm = Math.max(60, state.bpm - 5);
    document.getElementById('bpm-range').value = state.bpm;
    document.getElementById('bpm-val').textContent = state.bpm;
  }
  if (e.key === ']') {
    state.bpm = Math.min(200, state.bpm + 5);
    document.getElementById('bpm-range').value = state.bpm;
    document.getElementById('bpm-val').textContent = state.bpm;
  }
  // -/+ 调音量
  if (e.key === '-' || e.key === '_') {
    const v = Math.max(0, Math.round(state.volume * 100) - 5);
    state.volume = v / 100;
    document.getElementById('vol-range').value = v;
    document.getElementById('vol-val').textContent = v;
    audio.setVolume(state.volume);
  }
  if (e.key === '=' || e.key === '+') {
    const v = Math.min(100, Math.round(state.volume * 100) + 5);
    state.volume = v / 100;
    document.getElementById('vol-range').value = v;
    document.getElementById('vol-val').textContent = v;
    audio.setVolume(state.volume);
  }
});

let helpVisible = false;
// 显示/隐藏快捷键帮助面板
function toggleHelpPanel() {
  helpVisible = !helpVisible;
  const el = document.getElementById('help-panel');
  if (el) el.classList.toggle('show', helpVisible);
}
window.addEventListener('resize', () => viz.resize());

// ================================================================
//  主题切换：五种主题配色持久化到 localStorage
// ================================================================
const THEME_KEY = 'seq_theme';

// 切换界面主题并更新主题选择器激活状态
function setTheme(name) {
  document.documentElement.dataset.theme = name;
  document.querySelectorAll('.theme-dot').forEach(d => {
    d.classList.toggle('active', d.dataset.theme === name);
  });
  localStorage.setItem(THEME_KEY, name);
}

// 从 localStorage 读取并恢复主题（兼容旧主题名迁移）
function initTheme() {
  let saved = localStorage.getItem(THEME_KEY) || 'cyber';
  // 旧版本主题名迁移映射
  const migrate = { sunset: 'light', candy: 'wire' };
  if (migrate[saved]) saved = migrate[saved];
  setTheme(saved);
}

// ================================================================
//  应用初始化：主题、控件、音频引擎、默认数据
// ================================================================
// 应用入口：按顺序初始化所有模块
function init() {
  initTheme();          // 恢复上次使用的主题
  initControls();       // 绑定滑块、下拉框事件
  audio.generateBuiltInSamples(); // 生成 8 种内置合成器音色
  switchDrumPreset('classic');    // 默认使用经典鼓音色
  renderProjectSelect();    // 渲染工程下拉框
  renderSamplePresetSelect(); // 渲染预制下拉框
  renderAll();          // 渲染全部 UI
  viz.start();          // 启动可视化器
  // 尝试从 URL Hash 加载分享的 Pattern，若无则显示欢迎提示
  if (!loadFromHash()) {
    showToast('Built-in samples ready! Select a slot (1-8), click grid. Space to play.', '');
  }
}
// DOM 加载完成后启动应用
document.addEventListener('DOMContentLoaded', init);
