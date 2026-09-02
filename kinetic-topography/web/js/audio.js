// Fully synthesised sound design - no audio assets, nothing to download.
// Everything is built from oscillators, filters and one noise buffer.

export class Sound {
  constructor() {
    this.ctx = null;
    this.enabled = false;
    this.ready = false;
    this.nodes = {};
  }

  /** Must be called from a user gesture; browsers will not start audio otherwise. */
  async init() {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') await this.ctx.resume();
      return true;
    }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return false;
    const ctx = new AC();
    this.ctx = ctx;

    const master = ctx.createGain();
    master.gain.value = 0.0001;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -18;
    comp.ratio.value = 6;
    comp.attack.value = 0.004;
    comp.release.value = 0.25;
    master.connect(comp).connect(ctx.destination);
    this.nodes.master = master;

    // Reusable pink-ish noise, two seconds, looped.
    const len = ctx.sampleRate * 2;
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    let b0 = 0, b1 = 0, b2 = 0;
    for (let i = 0; i < len; i++) {
      const w = Math.random() * 2 - 1;
      b0 = 0.99765 * b0 + w * 0.0990460;
      b1 = 0.96300 * b1 + w * 0.2965164;
      b2 = 0.57000 * b2 + w * 1.0526913;
      d[i] = (b0 + b1 + b2 + w * 0.1848) * 0.22;
    }
    this.noiseBuf = buf;

    this._startAmbient();
    if (this.ctx.state === 'suspended') await this.ctx.resume();
    this.ready = true;
    if (this.enabled) this._fadeMaster(0.9, 1.2);
    return true;
  }

  setEnabled(on) {
    this.enabled = on;
    if (!this.ctx) return;
    this._fadeMaster(on ? 0.9 : 0.0001, 0.4);
  }

  _fadeMaster(v, t) {
    const g = this.nodes.master.gain;
    const now = this.ctx.currentTime;
    g.cancelScheduledValues(now);
    g.setValueAtTime(Math.max(g.value, 0.0001), now);
    g.exponentialRampToValueAtTime(Math.max(v, 0.0001), now + t);
  }

  _noise() {
    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    src.loop = true;
    return src;
  }

  /** A slow bed that lives for the whole session; its filter tracks "energy". */
  _startAmbient() {
    const ctx = this.ctx;
    const bus = ctx.createGain();
    bus.gain.value = 0.16;
    bus.connect(this.nodes.master);

    const filt = ctx.createBiquadFilter();
    filt.type = 'lowpass';
    filt.frequency.value = 420;
    filt.Q.value = 1.6;
    filt.connect(bus);

    for (const [f, det, g] of [[55, 0, 0.5], [55, 7, 0.35], [82.5, -5, 0.22], [110, 4, 0.12]]) {
      const o = ctx.createOscillator();
      o.type = 'sine';
      o.frequency.value = f;
      o.detune.value = det;
      const og = ctx.createGain();
      og.gain.value = g;
      o.connect(og).connect(filt);
      o.start();
    }

    // Airy top layer.
    const air = this._noise();
    const ab = ctx.createBiquadFilter();
    ab.type = 'bandpass';
    ab.frequency.value = 2400;
    ab.Q.value = 0.8;
    const ag = ctx.createGain();
    ag.gain.value = 0.05;
    air.connect(ab).connect(ag).connect(bus);
    air.start();

    // Very slow breathing motion.
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 0.07;
    const lg = ctx.createGain();
    lg.gain.value = 160;
    lfo.connect(lg).connect(filt.frequency);
    lfo.start();

    this.nodes.ambient = { bus, filt };
  }

  /** Push the ambient bed brighter as the password gains weight. */
  setEnergy(e) {
    if (!this.ready) return;
    const { filt, bus } = this.nodes.ambient;
    const now = this.ctx.currentTime;
    filt.frequency.setTargetAtTime(420 + e * 1500, now, 0.35);
    bus.gain.setTargetAtTime(0.16 + e * 0.12, now, 0.35);
  }

  /** Keystroke: a tight blip that climbs as the password grows. */
  key(progress = 0, heavy = false) {
    if (!this.ready || !this.enabled) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;

    const o = ctx.createOscillator();
    o.type = heavy ? 'triangle' : 'sine';
    const base = heavy ? 210 : 620;
    o.frequency.setValueAtTime(base * (1 + progress * 1.35), t);
    o.frequency.exponentialRampToValueAtTime(base * 0.55, t + 0.16);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(heavy ? 0.34 : 0.16, t + 0.006);
    g.gain.exponentialRampToValueAtTime(0.0001, t + (heavy ? 0.30 : 0.15));
    o.connect(g).connect(this.nodes.master);
    o.start(t); o.stop(t + 0.35);

    const n = this._noise();
    const nf = ctx.createBiquadFilter();
    nf.type = 'highpass';
    nf.frequency.value = 2200;
    const ng = ctx.createGain();
    ng.gain.setValueAtTime(0.09, t);
    ng.gain.exponentialRampToValueAtTime(0.0001, t + 0.07);
    n.connect(nf).connect(ng).connect(this.nodes.master);
    n.start(t); n.stop(t + 0.1);
  }

  /** The rising low-frequency hum while the server thinks. */
  humStart(duration = 2.6) {
    if (!this.ready || !this.enabled) return;
    this.humStop(0.05);
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const bus = ctx.createGain();
    bus.gain.setValueAtTime(0.0001, t);
    bus.gain.exponentialRampToValueAtTime(0.5, t + 0.5);
    bus.connect(this.nodes.master);

    const filt = ctx.createBiquadFilter();
    filt.type = 'lowpass';
    filt.frequency.setValueAtTime(160, t);
    filt.frequency.exponentialRampToValueAtTime(2600, t + duration);
    filt.Q.value = 5;
    filt.connect(bus);

    const oscs = [];
    for (const [f, det] of [[41, 0], [41, 11], [61.5, -7], [82, 5]]) {
      const o = ctx.createOscillator();
      o.type = 'sawtooth';
      o.frequency.setValueAtTime(f, t);
      o.frequency.exponentialRampToValueAtTime(f * 2.15, t + duration);
      o.detune.value = det;
      const g = ctx.createGain();
      g.gain.value = 0.18;
      o.connect(g).connect(filt);
      o.start(t);
      oscs.push(o);
    }

    // Doppler-ish shimmer riding on top.
    const n = this._noise();
    const nf = ctx.createBiquadFilter();
    nf.type = 'bandpass';
    nf.frequency.setValueAtTime(600, t);
    nf.frequency.exponentialRampToValueAtTime(5200, t + duration);
    nf.Q.value = 3;
    const ng = ctx.createGain();
    ng.gain.setValueAtTime(0.0001, t);
    ng.gain.exponentialRampToValueAtTime(0.28, t + duration * 0.8);
    n.connect(nf).connect(ng).connect(bus);
    n.start(t);

    this.nodes.hum = { bus, oscs, n };
  }

  humStop(fade = 0.25) {
    const h = this.nodes.hum;
    if (!h || !this.ctx) return;
    const t = this.ctx.currentTime;
    h.bus.gain.cancelScheduledValues(t);
    h.bus.gain.setValueAtTime(Math.max(h.bus.gain.value, 0.0001), t);
    h.bus.gain.exponentialRampToValueAtTime(0.0001, t + fade);
    for (const o of h.oscs) o.stop(t + fade + 0.05);
    h.n.stop(t + fade + 0.05);
    this.nodes.hum = null;
  }

  /** Alignment: a bright major chord with a rising sweep behind it. */
  success() {
    if (!this.ready || !this.enabled) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const bus = ctx.createGain();
    bus.gain.value = 0.5;
    bus.connect(this.nodes.master);

    [220, 277.18, 329.63, 440, 659.26].forEach((f, i) => {
      const o = ctx.createOscillator();
      o.type = i > 2 ? 'sine' : 'triangle';
      o.frequency.value = f;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t + i * 0.035);
      g.gain.exponentialRampToValueAtTime(0.22 / (i * 0.5 + 1), t + i * 0.035 + 0.03);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 1.9);
      o.connect(g).connect(bus);
      o.start(t + i * 0.035); o.stop(t + 2.1);
    });

    const sweep = ctx.createOscillator();
    sweep.type = 'sawtooth';
    sweep.frequency.setValueAtTime(120, t);
    sweep.frequency.exponentialRampToValueAtTime(3200, t + 0.65);
    const sf = ctx.createBiquadFilter();
    sf.type = 'bandpass'; sf.Q.value = 8;
    sf.frequency.setValueAtTime(400, t);
    sf.frequency.exponentialRampToValueAtTime(6000, t + 0.65);
    const sg = ctx.createGain();
    sg.gain.setValueAtTime(0.18, t);
    sg.gain.exponentialRampToValueAtTime(0.0001, t + 0.9);
    sweep.connect(sf).connect(sg).connect(bus);
    sweep.start(t); sweep.stop(t + 1.0);
  }

  /** The jam: a detuned downward buzz and a dry impact. */
  failure() {
    if (!this.ready || !this.enabled) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const bus = ctx.createGain();
    bus.gain.value = 0.55;
    bus.connect(this.nodes.master);

    for (const det of [0, 24, -19]) {
      const o = ctx.createOscillator();
      o.type = 'sawtooth';
      o.detune.value = det;
      o.frequency.setValueAtTime(150, t);
      o.frequency.exponentialRampToValueAtTime(42, t + 0.55);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.22, t);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.7);
      const f = ctx.createBiquadFilter();
      f.type = 'lowpass';
      f.frequency.setValueAtTime(2600, t);
      f.frequency.exponentialRampToValueAtTime(220, t + 0.6);
      o.connect(f).connect(g).connect(bus);
      o.start(t); o.stop(t + 0.8);
    }

    const n = this._noise();
    const nf = ctx.createBiquadFilter();
    nf.type = 'bandpass';
    nf.frequency.setValueAtTime(3200, t);
    nf.frequency.exponentialRampToValueAtTime(300, t + 0.4);
    nf.Q.value = 1.2;
    const ng = ctx.createGain();
    ng.gain.setValueAtTime(0.34, t);
    ng.gain.exponentialRampToValueAtTime(0.0001, t + 0.5);
    n.connect(nf).connect(ng).connect(bus);
    n.start(t); n.stop(t + 0.6);
  }

  /** Panel landing back into place. */
  thud() {
    if (!this.ready || !this.enabled) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(180, t);
    o.frequency.exponentialRampToValueAtTime(48, t + 0.22);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.4, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.4);
    o.connect(g).connect(this.nodes.master);
    o.start(t); o.stop(t + 0.5);
  }
}
