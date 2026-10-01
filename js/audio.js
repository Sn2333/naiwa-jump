/** audio.js —— 轻量 WebAudio 音效（无外部资源） */
export class Sound {
  constructor() {
    this.ctx = null;
    this.muted = false;
    this.chargeOsc = null;
    this.chargeGain = null;
  }

  ensure() {
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      this.ctx = new AC();
    }
    if (this.ctx.state === 'suspended') this.ctx.resume();
    return this.ctx;
  }

  tone(freq, dur, type = 'sine', vol = 0.16, slideTo = null, delay = 0) {
    if (this.muted) return;
    const ctx = this.ensure();
    if (!ctx) return;
    const t0 = ctx.currentTime + delay;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t0);
    if (slideTo) osc.frequency.exponentialRampToValueAtTime(Math.max(30, slideTo), t0 + dur);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(vol, t0 + Math.min(0.02, dur * 0.2));
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(g).connect(ctx.destination);
    osc.start(t0);
    osc.stop(t0 + dur + 0.05);
  }

  noise(dur = 0.14, vol = 0.12, freq = 900) {
    if (this.muted) return;
    const ctx = this.ensure();
    if (!ctx) return;
    const n = Math.floor(ctx.sampleRate * dur);
    const buf = ctx.createBuffer(1, n, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / n);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = freq;
    const g = ctx.createGain();
    g.gain.value = vol;
    src.connect(f).connect(g).connect(ctx.destination);
    src.start();
  }

  startCharge() {
    if (this.muted) return;
    const ctx = this.ensure();
    if (!ctx || this.chargeOsc) return;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(150, ctx.currentTime);
    g.gain.setValueAtTime(0.0001, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.07, ctx.currentTime + 0.05);
    osc.connect(g).connect(ctx.destination);
    osc.start();
    this.chargeOsc = osc;
    this.chargeGain = g;
  }

  updateCharge(p) {
    if (!this.chargeOsc || !this.ctx) return;
    const f = 150 + p * 520;
    this.chargeOsc.frequency.setTargetAtTime(f, this.ctx.currentTime, 0.03);
  }

  stopCharge() {
    if (!this.chargeOsc || !this.ctx) return;
    const osc = this.chargeOsc, g = this.chargeGain;
    const t = this.ctx.currentTime;
    g.gain.cancelScheduledValues(t);
    g.gain.setTargetAtTime(0.0001, t, 0.02);
    try { osc.stop(t + 0.12); } catch (e) { /* noop */ }
    this.chargeOsc = null;
    this.chargeGain = null;
  }

  jump() { this.tone(300, 0.20, 'sine', 0.18, 720); }
  land() { this.tone(190, 0.13, 'sine', 0.2, 90); this.noise(0.10, 0.07, 700); }
  perfect() {
    this.tone(880, 0.14, 'sine', 0.16);
    this.tone(1320, 0.16, 'sine', 0.13, null, 0.07);
    this.tone(1760, 0.22, 'sine', 0.10, null, 0.14);
  }
  bonus() {
    this.tone(1046, 0.12, 'triangle', 0.14);
    this.tone(1568, 0.14, 'triangle', 0.11, null, 0.08);
  }
  /** 挑角色：一声很轻的两音"叮咚"，别盖过主流程的反馈 */
  pick() {
    this.tone(988, 0.06, 'sine', 0.09);
    this.tone(1480, 0.09, 'sine', 0.06, null, 0.05);
  }
  /** 弹簧砖：一个快速上滑的"嘣" */
  spring() {
    this.tone(420, 0.16, 'triangle', 0.16, 1400);
    this.tone(880, 0.20, 'sine', 0.09, 1760, 0.05);
  }
  /** 黄桃彩蛋：甜甜的四音上行琶音 + 一声铃 */
  peach() {
    const seq = [784, 988, 1175, 1568];
    seq.forEach((f, i) => this.tone(f, 0.22, 'triangle', 0.14, null, i * 0.075));
    this.tone(2093, 0.42, 'sine', 0.09, null, 0.30);
  }
  fail() {
    this.tone(220, 0.5, 'sawtooth', 0.13, 60);
    this.noise(0.3, 0.08, 500);
  }
}

export const sound = new Sound();
