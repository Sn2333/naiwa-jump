/** audio.js —— 轻量 WebAudio 音效（无外部资源）
 *
 * 音量走一条**总线**（masterGain），所有声音都先接到它再进 destination。
 * 不这么做的话，"调音量"就得在每个 tone/noise 调用点各乘一次，漏一个就
 * 会出现"调小了还是有一声很响"。总线只有一处增益，绝不会漏。
 */

/** 两段"真实录音"音源的播放音量（见下方 laugh/ding 的注释）。
 *  单独拿出来是为了让探针能直接读、断言"确实调低过"。 */
export const CLIP_VOL = { laugh: 0.30, ding: 0.34 };

export class Sound {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.volume = 1;        // 0~1，设置面板里的"音效音量"
    this.muted = false;
    this.chargeOsc = null;
    this.chargeGain = null;
    /* 长音效片段（mp3 解码后的 AudioBuffer）：laugh=奶龙大笑、ding=冰冰冰的"叮叮叮"。
     * 都走同一条 prepare/play 链，加新音效只多一个名字。 */
    this.clips = {};
  }

  ensure() {
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      this.ctx = new AC();
      this.master = this.ctx.createGain();
      this.master.gain.value = this.volume;
      this.master.connect(this.ctx.destination);
    }
    if (this.ctx.state === 'suspended') this.ctx.resume();
    return this.ctx;
  }

  /** 设置音量（0~1）。没建 ctx 也先记住，ensure() 时再套上去。 */
  setVolume(v) {
    this.volume = Math.max(0, Math.min(1, Number(v) || 0));
    if (this.master) this.master.gain.value = this.volume;
  }

  /** 所有声音的出口：建过 ctx 就是总线，没建就退化成 destination */
  _out(ctx) { return this.master || ctx.destination; }

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
    osc.connect(g).connect(this._out(ctx));
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
    src.connect(f).connect(g).connect(this._out(ctx));
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
    osc.connect(g).connect(this._out(ctx));
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
  /** 捡到砖上的奶币：一声很短的亮"叮"。
   *  刻意比 bonus 更轻更短 —— 一局要响几十次，重了会盖住跳跃和完美的反馈。 */
  coin() {
    this.tone(1318, 0.06, 'sine', 0.10);
    this.tone(1976, 0.09, 'sine', 0.07, null, 0.04);
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
  /** 冰冰冰：一声"结冰" —— 高频短促的下滑 + 一点噪声，听着像瞬间冻住 */
  freeze() {
    this.tone(2100, 0.22, 'triangle', 0.13, 900);
    this.tone(1400, 0.16, 'sine', 0.08, 620, 0.04);
    this.noise(0.20, 0.06, 3800);
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

  /* ---------------- 长音效片段（mp3 → AudioBuffer） ----------------
   * ★ audio.js 刻意**不 import 任何模块** —— build.py 把它整个塞进一个
   *   独立 IIFE，多一行 import 就会原样留在产物里直接 SyntaxError。
   *   所以音源地址只能由 game.js 当参数传进来（它自己从媒体数据模块取）。
   *   ★ 注释里别写那个导出名 —— 静态检查是纯文本扫描，看到名字就当"用了没 import"。 */
  /** 预解码一段 data URI 音频。异步完成，完成后 playClip 才真的有声。 */
  prepareClip(name, uri) {
    const c = this.clips[name] || (this.clips[name] = { buf: null, loading: false, failed: false });
    if (!uri || c.buf || c.loading) return;
    const ctx = this.ensure();
    if (!ctx || !ctx.decodeAudioData) return;
    c.loading = true;
    try {
      const b64 = uri.slice(uri.indexOf(',') + 1);
      const bin = atob(b64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const p = ctx.decodeAudioData(bytes.buffer);
      const done = (buf) => { c.buf = buf; c.loading = false; };
      if (p && p.then) p.then(done, () => { c.loading = false; c.failed = true; });
      else c.loading = false;
    } catch (e) {
      c.loading = false;
      c.failed = true;
    }
  }

  /** 放一段片段。返回是否真的放出来了（没解码好 / 静音时为 false）。 */
  playClip(name, vol) {
    if (this.muted) return false;
    const ctx = this.ensure();
    const c = this.clips[name];
    if (!ctx || !c || !c.buf) return false;
    const src = ctx.createBufferSource();
    src.buffer = c.buf;
    const g = ctx.createGain();
    g.gain.value = vol;
    src.connect(g).connect(this._out(ctx));
    src.start();
    return true;
  }

  /* 两个具名片段：奶块的大笑、冰冰冰的"叮叮叮"。
   * 2026-10-04 按玩家反馈整体调低两次（0.85/0.9 → 0.55/0.6 → 0.30/0.34）：
   * 这两段是录来的真实音源，比合成音效本身响得多。
   * 大笑同时截成前 4 秒（原 9.98s 落到奶块上会一直笑）。
   * ★ 音量写成常量而不是内联字面量：探针要断言"调低过"，读常量比读魔法数字稳。 */
  laugh() { return this.playClip('laugh', CLIP_VOL.laugh); }
  ding() { return this.playClip('ding', CLIP_VOL.ding); }
}

export const sound = new Sound();
