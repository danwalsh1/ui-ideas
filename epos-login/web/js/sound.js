// The counter, in sound.
//
// Fully synthesised - no audio assets, nothing to download. Seven places on
// the counter, one room, and everything built from oscillators, filters and
// one noise buffer.
//
// Off until asked. Constructing this class touches no Web Audio at all: the
// context is created inside the toggle's click handler and nowhere else, so a
// visitor who opens the page and never presses anything never has an audio
// thread, let alone a sound.
//
// The scanner beep is the anchor. It is byte-identical from all three of its
// call sites, because hearing it forty times during idle is what makes it land
// when the badge crosses the same glass in phase 2.

const SILENT = 0.0001;      // every fade is exponential, undefined at zero
const MASTER_ON = 0.52;
const VOICE_CAP = 16;

/* The three bed levels, in one place because they are referenced from both the
   graph and the state table.

   These are measured, not chosen. Rendered offline, the bed has to sit around
   -45 dBFS: present enough that muting it is noticeable, quiet enough that you
   stop hearing it inside ninety seconds. The obvious values are an order of
   magnitude too hot - a room whose RMS is above the scanner beep's masks the
   reader tick, the bag and the paper tear completely. */
const BED_ROOM = 0.0150;
const BED_TERM = 0.0118;
const BED_BELT = 0.0118;

/* THE GAIN BUDGET, measured rather than chosen.
   Every voice was rendered on its own into an OfflineAudioContext and its peak
   compared with the beep's. The spread IS the restraint, and these are the
   figures the file currently produces:

     beep      0 dB   the anchor, and the only sound allowed to be loud
     chime    -6 dB   under the drawer: this is a shop till, not a fanfare
     printer -11 dB
     tear     -10 dB
     key      -16 dB   audibly subordinate by design
     tick     -20 dB
     bag      -20 dB
     decline  +4 dB   \ peak overstates loudness at 180Hz and 132Hz, so these
     drawer   +3 dB   / two sit high on paper and are not as loud as they read

   Do not trust the nominal gains in the code as levels. Pink noise here peaks
   near 0.8, so the same number applied to a noise source lands far hotter than
   it does on an oscillator; and a short exponential decay measures around a
   fifth of its nominal peak, which is why the beep - the one voice with a flat
   top - reads so much louder than its number suggests. Change a level, render
   it, and check the table. */

/* Distance is three parameters moving together - dry level, an air filter and
   send amount - because level alone is the weakest distance cue.

   Positions are read off the real stylesheets: the scanner from lane.css's
   --scan-x, the bag from its right offset, the drawer from approved.css. |pan|
   never exceeds 0.78; hard-panned events are unpleasant on headphones.

   Two worth defending. `drawer` is the nearest thing here and also one of the
   darkest and wettest, which is not a contradiction: it is close, but under a
   wooden counter, firing into an enclosed box. And `reader` is wetter than its
   distance justifies because it leans away from us towards the customer, and a
   source pointing away is heard mostly through the room. */
const PLACES = {
  keys:     { pan:  0.02, air: 12000, dry: 0.79, send: 0.08 },
  scanner:  { pan: -0.17, air:  9000, dry: 0.68, send: 0.30 },
  terminal: { pan:  0.00, air:  6000, dry: 0.72, send: 0.16 },
  reader:   { pan:  0.44, air:  7600, dry: 0.66, send: 0.30 },
  printer:  { pan: -0.46, air:  4200, dry: 0.52, send: 0.34 },
  drawer:   { pan: -0.04, air:  3400, dry: 0.84, send: 0.32 },
  bag:      { pan:  0.72, air:  6200, dry: 0.60, send: 0.26 },
};

export class SoundKit {
  constructor() {
    this.ctx = null;          // does hardware exist yet
    this.ready = false;       // is the graph built
    this.enabled = false;     // does the user want it
    this.dead = false;        // unavailable or threw; stop trying
    this.n = {};              // permanent nodes
    this.place = {};          // the seven position buses
    this.voices = 0;
    this.last = Object.create(null);
    this.state = 'idle';
  }

  static get supported() {
    return Boolean(window.AudioContext || window.webkitAudioContext);
  }

  /* ---------------------------------------------------------------- *
   * The gesture. Nothing in here may wait.
   *
   * Safari binds the user-gesture token to the synchronous part of the
   * handler and spends it on the first await. Chrome's resume() outside a
   * gesture does not reject - it returns a promise that never settles - so
   * it can never be used as a gate. arm() is synchronous end to end.
   * ---------------------------------------------------------------- */
  arm() {
    if (this.dead) return false;
    if (this.ctx) {
      if (this.ctx.state === 'closed') { this.ctx = null; this.ready = false; }
      else { this.ctx.resume(); return true; }
    }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) { this.dead = true; return false; }
    try {
      // 'interactive' because the beep's whole character is its attack.
      this.ctx = new AC({ latencyHint: 'interactive' });
      this.ctx.resume();                    // fired, never awaited

      // iOS wants a source actually started inside the gesture, not a resume.
      const s = this.ctx.createBufferSource();
      s.buffer = this.ctx.createBuffer(1, 1, this.ctx.sampleRate);
      s.connect(this.ctx.destination);
      s.start();

      this._build();                        // ~14ms, synchronous, once
      this.ctx.addEventListener('statechange', () => this._recover());
      this.ready = true;
      return true;
    } catch {
      this.dead = true;
      return false;
    }
  }

  /** Resolves once the context is genuinely running, or gives up. A race
      against a deadline, never an await on resume(). */
  whenRunning(ms = 300) {
    const ctx = this.ctx;
    if (!ctx) return Promise.resolve(false);
    if (ctx.state === 'running') return Promise.resolve(true);
    return new Promise((done) => {
      const finish = () => {
        ctx.removeEventListener('statechange', finish);
        clearTimeout(timer);
        done(ctx.state === 'running');
      };
      const timer = setTimeout(finish, ms);
      ctx.addEventListener('statechange', finish);
    });
  }

  setEnabled(on) {
    this.enabled = Boolean(on);
    if (!this.ready) return;
    if (this.enabled) this.fadeIn(0.7);
    else {
      // Never hard-stop a running bed; that is an audible click. Ramp, then
      // suspend once the ramp has actually finished.
      this._fade(this.n.master.gain, SILENT, 0.05);
      setTimeout(() => { if (!this.enabled) this.ctx?.suspend(); }, 120);
    }
  }

  fadeIn(secs = 0.7) {
    if (!this.ready) return;
    this.ctx.resume();
    this._fade(this.n.master.gain, MASTER_ON, secs);
  }

  /** One failure disables the kit rather than throwing sixty times a minute
      into a listener whose errors are swallowed. */
  _fail() {
    this.dead = true;
    this.enabled = false;
    this.ready = false;
    try { this.n.master?.gain.setValueAtTime(SILENT, this.ctx.currentTime); } catch {}
    this.onFail?.();
  }

  /* ---------------------------------------------------------------- *
   * Interrupting an in-flight automation. Anchor at the CURRENT value,
   * or a ramp already running carries on to its old target.
   * ---------------------------------------------------------------- */
  _fade(param, v, secs) {
    const t = this.ctx.currentTime;
    param.cancelScheduledValues(t);
    param.setValueAtTime(Math.max(param.value, SILENT), t);
    param.exponentialRampToValueAtTime(Math.max(v, SILENT), t + secs);
  }

  /** Attack to peak, an optional flat hold, then decay. Times in seconds.
      Anchors at t first: an AudioParam with no setValueAtTime sits at its
      .value (1 for a fresh GainNode) until its first scheduled event, which
      is the easiest way in this file to ship a full-scale burst.

      That anchor only covers the param from t onward. If the SOURCE starts
      earlier than the envelope does - a keycap that lands four milliseconds
      after the dome, coins that spill a tenth of a second after the drawer -
      the gap between them still runs at the node's default of 1. Every gain
      node feeding a delayed envelope therefore sets .value = SILENT when it
      is created. Without it a keystroke fires four milliseconds of full-scale
      sine and the drawer a tenth of a second of full-scale noise, which is
      what the envelope was written to prevent. */
  _env(param, t, peak, attack, decay, hold = 0) {
    param.setValueAtTime(SILENT, t);
    param.exponentialRampToValueAtTime(peak, t + attack);
    if (hold) param.setValueAtTime(peak, t + attack + hold);
    param.exponentialRampToValueAtTime(SILENT, t + attack + hold + decay);
  }

  _noise() {
    const s = this.ctx.createBufferSource();
    s.buffer = this.noiseBuf;
    s.loop = true;
    // So twelve beeps in a row share no transient.
    s.playbackRate.value = 0.92 + Math.random() * 0.16;
    return s;
  }

  /** Every source gets a stop time and hands its slot back. */
  _reap(node, endsAt) {
    this.voices++;
    node.onended = () => { this.voices--; try { node.disconnect(); } catch {} };
    node.stop(endsAt);
  }

  /** The retrigger floor. Returns the time to schedule at, or null.
      Null rather than 0 for "too soon", and an explicit undefined check for
      "never fired": currentTime is legitimately 0 for the first block of a
      context's life, so a falsy-time contract silently drops every gated
      sound for the first ninety milliseconds after the toggle is pressed. */
  _gate(name, minSecs) {
    const t = this.ctx.currentTime;
    const prev = this.last[name];
    if (prev !== undefined && t - prev < minSecs) return null;
    this.last[name] = t;
    return t;
  }

  /** Voss-McCartney pink. Cheaper than it looks and the only noise source in
      the file - every hiss, rattle and rustle here is this buffer filtered. */
  _pinkBuffer(seconds = 4) {
    const rate = this.ctx.sampleRate;
    const buf = this.ctx.createBuffer(1, Math.floor(rate * seconds), rate);
    const d = buf.getChannelData(0);
    let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
    for (let i = 0; i < d.length; i++) {
      const w = Math.random() * 2 - 1;
      b0 = 0.99886 * b0 + w * 0.0555179;
      b1 = 0.99332 * b1 + w * 0.0750759;
      b2 = 0.96900 * b2 + w * 0.1538520;
      b3 = 0.86650 * b3 + w * 0.3104856;
      b4 = 0.55000 * b4 + w * 0.5329522;
      b5 = -0.7616 * b5 - w * 0.0168980;
      d[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11;
      b6 = w * 0.115926;
    }
    return buf;
  }

  /* ---------------------------------------------------------------- *
   * The room. One convolver, generated, no files.
   *
   * The 11ms pre-delay separates direct sound from first reflection and is
   * what gives the room a size - about three metres. The 220Hz highpass on
   * the send is the difference between a room and a boom.
   * ---------------------------------------------------------------- */
  _roomIR() {
    const ctx = this.ctx;
    const rate = ctx.sampleRate;
    const len = Math.floor(rate * 0.52);
    const ir = ctx.createBuffer(2, len, rate);
    // The surfaces the scene actually has: counter top, terminal casing, the
    // wall the room gradient falls into, the shop front off right, ceiling.
    const early = [
      [7.5, 0.42, 0.26], [11.2, 0.23, 0.37], [19.0, 0.31, 0.21],
      [26.5, 0.17, 0.28], [37.0, 0.20, 0.16], [48.5, 0.12, 0.16],
    ];
    for (let c = 0; c < 2; c++) {
      const d = ir.getChannelData(c);
      let lp = 0;
      for (let i = 0; i < len; i++) {
        const t = i / rate;
        // Two decay rates summed. The bright one dies in ~200ms, the dark one
        // in ~600ms, so the tail darkens as it fades with no filter sweeping.
        const w = Math.random() * 2 - 1;
        lp += 0.16 * (w - lp);
        d[i] = (w * Math.exp(-t * 14.0) * 0.55 + lp * Math.exp(-t * 5.2) * 1.90) * 0.5;
      }
      for (const [ms, gL, gR] of early) {
        const at = Math.floor((ms + (c ? 0.6 : -0.6)) * rate / 1000);
        if (at < len) d[at] += (c ? gR : gL);   // jittered, so the two sides
      }                                         // are genuinely decorrelated
    }
    return ir;
  }

  _place(name) {
    const ctx = this.ctx;
    const p = PLACES[name];
    const inp = ctx.createGain();
    const air = ctx.createBiquadFilter();
    air.type = 'lowpass';
    air.frequency.value = p.air;
    air.Q.value = 0.4;
    inp.connect(air);

    let out = air;
    if (ctx.createStereoPanner) {
      const pan = ctx.createStereoPanner();
      pan.pan.value = p.pan;
      air.connect(pan);
      out = pan;
    }

    const dry = ctx.createGain();
    dry.gain.value = p.dry;
    out.connect(dry).connect(this.n.master);

    // Post-pan, so the room inherits position: a 2-channel input against a
    // 2-channel impulse convolves each side independently.
    if (this.n.send) {
      const s = ctx.createGain();
      s.gain.value = p.send;
      out.connect(s).connect(this.n.send);
    }
    return { in: inp, air, dry, base: p.dry };
  }

  _build() {
    const ctx = this.ctx;
    const n = this.n;

    n.master = ctx.createGain();
    n.master.gain.value = SILENT;

    // The counter beeps forty times a minute at 2.7kHz. Two decibels off the
    // top is the difference between the fortieth one and the fourth.
    const shelf = ctx.createBiquadFilter();
    shelf.type = 'highshelf';
    shelf.frequency.value = 7500;
    shelf.gain.value = -2;

    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -16;
    comp.knee.value = 6;
    comp.ratio.value = 5;
    comp.attack.value = 0.003;
    comp.release.value = 0.22;

    n.master.connect(shelf).connect(comp).connect(ctx.destination);

    this.noiseBuf = this._pinkBuffer(4);

    // The room send. If convolution is unavailable the kit simply runs dry -
    // drier and closer, but complete.
    try {
      const send = ctx.createGain();
      const pre = ctx.createDelay(0.05);
      pre.delayTime.value = 0.011;
      const lo = ctx.createBiquadFilter();
      lo.type = 'lowpass'; lo.frequency.value = 3200; lo.Q.value = 0.4;
      const hi = ctx.createBiquadFilter();
      hi.type = 'highpass'; hi.frequency.value = 220; hi.Q.value = 0.7;
      const conv = ctx.createConvolver();
      conv.buffer = this._roomIR();
      const ret = ctx.createGain();
      ret.gain.value = 0.38;
      send.connect(pre).connect(lo).connect(hi).connect(conv).connect(ret).connect(n.master);
      n.send = send;
    } catch {
      n.send = null;
    }

    for (const name of Object.keys(PLACES)) this.place[name] = this._place(name);

    this._buildBeds();
    this._buildPrinter();
    this._buildDecline();
    this._reframe();
  }

  /* ---------------------------------------------------------------- *
   * The ambient bed. Three buses, because two states are defined by
   * which of them stops.
   * ---------------------------------------------------------------- */
  _buildBeds() {
    const ctx = this.ctx;
    const n = this.n;
    const bus = (v, sendAmt) => {
      const g = ctx.createGain();
      g.gain.value = v;
      g.connect(n.master);
      if (n.send) {
        const s = ctx.createGain();
        s.gain.value = sendAmt;
        g.connect(s).connect(n.send);
      }
      return g;
    };

    n.room = bus(BED_ROOM, 0.30);   // air conditioning and the shop's mains
    n.term = bus(BED_TERM, 0.10);   // the terminal's own supply, a foot away
    n.belt = bus(SILENT, 0.22);     // the motor, only while the lane runs

    // AIR. Pink noise under a 240Hz lowpass is the cheapest convincing large
    // room there is: everything that could identify itself as a loop has been
    // taken off the top. Two copies at slightly different rates, started
    // apart, so the composite repeat period is a couple of hours.
    const airLp = ctx.createBiquadFilter();
    airLp.type = 'lowpass'; airLp.frequency.value = 240; airLp.Q.value = 0.6;
    airLp.connect(n.room);
    for (const [rate, delay] of [[1.0, 0], [0.977, 1.7]]) {
      const s = ctx.createBufferSource();
      s.buffer = this.noiseBuf;
      s.loop = true;
      s.playbackRate.value = rate;
      const g = ctx.createGain();
      g.gain.value = 0.55;
      s.connect(g).connect(airLp);
      s.start(ctx.currentTime + delay);
    }
    const airLfo = ctx.createOscillator();
    airLfo.type = 'sine';
    airLfo.frequency.value = 0.043;              // a 23-second cycle
    const airDepth = ctx.createGain();
    airDepth.gain.value = 55;
    airLfo.connect(airDepth).connect(airLp.frequency);
    airLfo.start();

    // MAINS. 99.06 is deliberately 0.06Hz off twice 49.5, so the two walk in
    // and out of phase every seventeen seconds and the low end never sits
    // still. (The source design wanted this drift but named 98.4Hz, which
    // beats at 0.6Hz - a wobble, not a drift.)
    for (const [f, g, dest] of [[49.5, 0.20, n.room], [99.06, 0.26, n.term]]) {
      const o = ctx.createOscillator();
      o.type = 'sine';
      o.frequency.value = f;
      const a = ctx.createGain();
      a.gain.value = g;
      o.connect(a).connect(dest);
      o.start();
    }

    // The screen's own air, on the terminal rather than the shop.
    const top = this._noise();
    const topBp = ctx.createBiquadFilter();
    topBp.type = 'bandpass'; topBp.frequency.value = 3100; topBp.Q.value = 0.55;
    const topG = ctx.createGain();
    topG.gain.value = 0.16;
    top.connect(topBp).connect(topG).connect(n.term);
    top.start();

    // BELT. A conveyor motor: a sawtooth pair under a resonant lowpass.
    const beltLp = ctx.createBiquadFilter();
    beltLp.type = 'lowpass'; beltLp.frequency.value = 300; beltLp.Q.value = 3.0;
    beltLp.connect(n.belt);
    n.beltSaw = ctx.createOscillator();
    n.beltSaw.type = 'sawtooth'; n.beltSaw.frequency.value = 47.0;
    const bg1 = ctx.createGain(); bg1.gain.value = 0.62;
    n.beltSaw.connect(bg1).connect(beltLp); n.beltSaw.start();
    n.beltSaw2 = ctx.createOscillator();
    n.beltSaw2.type = 'sawtooth'; n.beltSaw2.frequency.value = 70.5;
    const bg2 = ctx.createGain(); bg2.gain.value = 0.28;
    n.beltSaw2.connect(bg2).connect(beltLp); n.beltSaw2.start();

    const roll = this._noise();
    n.roller = ctx.createBiquadFilter();
    n.roller.type = 'bandpass'; n.roller.frequency.value = 520; n.roller.Q.value = 1.4;
    const rollG = ctx.createGain(); rollG.gain.value = 0.34;
    roll.connect(n.roller).connect(rollG).connect(n.belt);
    roll.start();
  }

  /** Ramp gain and pitch together, which gives a falling-pitch spin-down for
      free and needs no polling of the lane's speed. 0.20s is 1/5.5, the same
      easing constant the belt itself uses, so the motor and the belt slow at
      exactly the same rate. */
  _belt(k) {
    const t = this.ctx.currentTime;
    const on = this.n.beltVisible === false ? 0 : k;
    this.n.belt.gain.setTargetAtTime(Math.max(BED_BELT * on, SILENT), t, 0.22);
    this.n.beltSaw.frequency.setTargetAtTime(47 * (0.55 + 0.45 * on), t, 0.20);
    this.n.beltSaw2.frequency.setTargetAtTime(70.5 * (0.55 + 0.45 * on), t, 0.20);
    this.n.roller.frequency.setTargetAtTime(380 + 260 * on, t, 0.20);
  }

  /* ---------------------------------------------------------------- *
   * The printer. A thermal receipt printer feeds 0.125mm per step at
   * 50-100mm/s, so the audible fundamental IS the step rate - 400-800
   * steps a second. That is why one buzzes like a trapped hornet and
   * not like a motor.
   * ---------------------------------------------------------------- */
  _buildPrinter() {
    const ctx = this.ctx;
    const n = this.n;
    const dest = this.place.printer.in;

    n.motor = ctx.createOscillator();
    n.motor.type = 'sawtooth';
    n.motor.frequency.value = 300;
    n.motorBody = ctx.createBiquadFilter();
    n.motorBody.type = 'lowpass'; n.motorBody.frequency.value = 1800; n.motorBody.Q.value = 3.5;
    n.motorGate = ctx.createGain();
    n.motorGate.gain.value = SILENT;
    const housing = ctx.createBiquadFilter();
    housing.type = 'lowpass'; housing.frequency.value = 7000;
    n.motor.connect(n.motorBody).connect(n.motorGate).connect(housing).connect(dest);
    n.motor.start();

    const paper = this._noise();
    const paperBp = ctx.createBiquadFilter();
    paperBp.type = 'bandpass'; paperBp.frequency.value = 3400; paperBp.Q.value = 0.9;
    n.paperGate = ctx.createGain();
    n.paperGate.gain.value = SILENT;
    paper.connect(paperBp).connect(n.paperGate).connect(dest);
    paper.start();

    // The bed under a run of steps. 13.51Hz is 1/0.074s - the same number the
    // printer's visible body shake uses, so the audible buzz rate and the
    // visible shake rate are one value.
    //
    // The tremolo is a gain INSIDE the gated path, not modulation added to the
    // gate itself: an LFO summed into a gated param keeps its depth when the
    // gate is closed, which would leave the saw audible for the life of the
    // page.
    const bedSaw = ctx.createOscillator();
    bedSaw.type = 'sawtooth'; bedSaw.frequency.value = 240;
    const bedBp = ctx.createBiquadFilter();
    bedBp.type = 'bandpass'; bedBp.frequency.value = 900; bedBp.Q.value = 2.0;
    const bedTrem = ctx.createGain();
    bedTrem.gain.value = 1.0;
    n.printBed = ctx.createGain();
    n.printBed.gain.value = SILENT;
    bedSaw.connect(bedBp).connect(bedTrem).connect(n.printBed).connect(dest);
    bedSaw.start();

    const lfo = ctx.createOscillator();
    lfo.type = 'sine';
    lfo.frequency.value = 13.51;
    const lfoDepth = ctx.createGain();
    lfoDepth.gain.value = 0.6;
    lfo.connect(lfoDepth).connect(bedTrem.gain);
    lfo.start();
  }

  /* ---------------------------------------------------------------- *
   * The decline. The same electromagnetic annunciator that makes the
   * chime, driven at 180Hz - far below its resonance, where a magnetic
   * transducer is inefficient and rattly. That is why a decline sounds
   * cheap: you hear the drive's edges, not a resonance.
   * ---------------------------------------------------------------- */
  _buildDecline() {
    const ctx = this.ctx;
    const n = this.n;

    const sq = ctx.createOscillator();
    sq.type = 'square';
    sq.frequency.value = 180;

    // The diaphragm buzzing against its cage. 92Hz is not a submultiple of
    // 180, which is what makes it grate. Same discipline as the printer bed:
    // the rattle multiplies the signal inside the gate rather than being
    // summed into the gate, or it would buzz continuously while silent.
    const rattle = ctx.createGain();
    rattle.gain.value = 1.0;
    const lfo = ctx.createOscillator();
    lfo.type = 'square';
    lfo.frequency.value = 92;
    const depth = ctx.createGain();
    depth.gain.value = 0.48;
    lfo.connect(depth).connect(rattle.gain);
    lfo.start();

    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass'; lp.frequency.value = 2600; lp.Q.value = 0.6;
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass'; hp.frequency.value = 120;
    n.buzz = ctx.createGain();
    n.buzz.gain.value = SILENT;

    sq.connect(rattle).connect(lp).connect(hp).connect(n.buzz).connect(this.place.terminal.in);
    sq.start();
  }

  /* ================================================================ *
   * The sounds
   * ================================================================ */

  /** The anchor, and the only sound allowed to be loud. Square, not sine - a
      sine at 2.7kHz is a hearing test; a piezo has odd harmonics and sounds
      like plastic. And a flat top, because a piezo is driven by a rectangular
      gate rather than an envelope generator. */
  beep() {
    if (!this.ready || !this.enabled || this.voices >= VOICE_CAP) return;
    const t = this._gate('beep', 0.09);
    if (t === null) return;
    try {
      const ctx = this.ctx;
      const dest = this.place.scanner.in;

      // One beep is identical to the next - that is what makes it a scanner.
      // But a hundred in a row must not sound like a loop, so the length and
      // the level wander by an amount nobody could name.
      const len = 0.088 + Math.random() * 0.008;
      const peak = 0.30 * (0.96 + Math.random() * 0.08);

      const bus = ctx.createGain();
      this._env(bus.gain, t, peak, 0.0012, 0.022, len - 0.0232);
      bus.connect(dest);

      // Keeps the 3rd harmonic at 8.1kHz, which is the plastic, and kills the
      // 5th and 7th, which are the fatigue.
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass'; lp.frequency.value = 8200; lp.Q.value = 0.7;
      lp.connect(bus);

      // 5402 is two cents sharp of the octave. A square has no even harmonics,
      // so this fills one in slightly wrong - the faintly out-of-tune ring a
      // cheap piezo has.
      for (const [f, g] of [[2700, 0.72], [5402, 0.16]]) {
        const o = ctx.createOscillator();
        o.type = 'square';
        o.frequency.value = f;
        const og = ctx.createGain();
        og.gain.value = g;
        o.connect(og).connect(lp);
        o.start(t);
        this._reap(o, t + len + 0.02);
      }

      // The diaphragm snapping. Straight to the place, so the flat top of the
      // envelope above cannot hold it open.
      const n = this._noise();
      const hp = ctx.createBiquadFilter();
      hp.type = 'highpass'; hp.frequency.value = 3000;
      const ng = ctx.createGain();
      ng.gain.setValueAtTime(0.05, t);
      ng.gain.exponentialRampToValueAtTime(SILENT, t + 0.008);
      n.connect(hp).connect(ng).connect(dest);
      n.start(t);
      this._reap(n, t + 0.02);
    } catch { this._fail(); }
  }

  /** A rubber-dome keyboard makes two sounds about four milliseconds apart:
      the dome buckling, then the keycap bottoming out on the mounting plate.
      Pitch varies by physical key, not by character - different keys sit at
      different distances from the plate's screws - so a capital A and a
      lowercase a sound identical. Shift does not move the plate. */
  key(event) {
    if (!this.ready || !this.enabled || this.voices >= VOICE_CAP) return;
    if (event.repeat || event.ctrlKey || event.metaKey || event.altKey) return;
    if (event.key.length !== 1 && event.key !== 'Backspace' && event.key !== 'Enter') return;
    const t = this._gate('key', 0.022);
    if (t === null) return;
    try {
      const ctx = this.ctx;
      const dest = this.place.keys.in;

      const code = event.code || event.key;
      let h = 0;
      for (let i = 0; i < code.length; i++) h = (h * 31 + code.charCodeAt(i)) & 1023;
      const vary = 1 + (h / 1023 - 0.5) * 0.14;
      const big = code === 'Space' || code === 'Enter' || code === 'Backspace';
      const lvl = big ? 1.3 : 1;

      const n = this._noise();
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass'; bp.frequency.value = 2600; bp.Q.value = 1.1;
      const ng = ctx.createGain();
      ng.gain.setValueAtTime(0.050 * lvl, t);
      ng.gain.exponentialRampToValueAtTime(SILENT, t + 0.005);
      n.connect(bp).connect(ng).connect(dest);
      n.start(t);
      this._reap(n, t + 0.02);

      // The plate, four milliseconds later. A cap has to travel before it
      // lands.
      const o = ctx.createOscillator();
      o.type = 'sine';
      const f0 = (big ? 122 : 168) * vary;
      o.frequency.setValueAtTime(f0, t);
      o.frequency.exponentialRampToValueAtTime(f0 * 0.86, t + 0.030);
      const og = ctx.createGain();
      og.gain.value = SILENT;          // see _env: the gap before the anchor
      this._env(og.gain, t + 0.004, 0.146 * lvl, 0.0035, 0.030);
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass'; lp.frequency.value = 900;
      o.connect(og).connect(lp).connect(dest);
      o.start(t);
      this._reap(o, t + 0.08);
    } catch { this._fail(); }
  }

  /** The reader waking. Chosen negative-space first: high enough to read as
      electronic, far enough below 2700 that it can never be mistaken for a
      scan - and a fourth below it, so the badge beep lands as an answer. */
  tick() {
    if (!this.ready || !this.enabled) return;
    const t = this._gate('tick', 0.2);
    if (t === null) return;
    try {
      const ctx = this.ctx;
      const dest = this.place.reader.in;

      const o = ctx.createOscillator();
      o.type = 'sine';
      o.frequency.value = 1180;
      const og = ctx.createGain();
      this._env(og.gain, t, 0.210, 0.0008, 0.026, 0.0045);
      o.connect(og).connect(dest);
      o.start(t);
      this._reap(o, t + 0.05);

      const n = this._noise();
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass'; bp.frequency.value = 2600; bp.Q.value = 3.5;
      const ng = ctx.createGain();
      ng.gain.setValueAtTime(0.170, t);
      ng.gain.exponentialRampToValueAtTime(SILENT, t + 0.012);
      n.connect(bp).connect(ng).connect(dest);
      n.start(t);
      this._reap(n, t + 0.03);
    } catch { this._fail(); }
  }

  /** The room leaves and the machine strains. A purely rising drone is a
      spaceship; a fixed low anchor with a rising component over it is strain.
      Stopped by the next transition, never by a timer - the authorising floor
      is a minimum, not a duration. */
  humStart(duration = 2.35) {
    if (!this.ready || !this.enabled) return;
    this.humStop(0.05);
    try {
      const ctx = this.ctx;
      const t = ctx.currentTime;
      const bus = ctx.createGain();
      bus.gain.value = SILENT;
      this._fade(bus.gain, 0.30, 0.35);
      bus.connect(this.place.terminal.in);
      const oscs = [];

      // The power supply. Transformer magnetostriction radiates at twice line
      // frequency, so 100Hz here. Fixed: mains does not rise.
      const psu = ctx.createBiquadFilter();
      psu.type = 'lowpass'; psu.frequency.value = 400; psu.Q.value = 0.7;
      psu.connect(bus);
      for (const [f, g] of [[50, 0.09], [100, 0.14], [150, 0.05], [200, 0.035]]) {
        const o = ctx.createOscillator();
        o.type = 'sine';
        o.frequency.value = f;
        const a = ctx.createGain();
        a.gain.value = g;
        o.connect(a).connect(psu);
        o.start(t);
        oscs.push(o);
      }

      // The fan, which is what rises. Blade-pass is RPM/60 x blades; a
      // seven-blade 40mm fan spinning 4000 -> 7200 RPM is 467 -> 840Hz.
      const blade = ctx.createOscillator();
      blade.type = 'triangle';
      blade.frequency.setValueAtTime(467, t);
      blade.frequency.exponentialRampToValueAtTime(840, t + duration);
      const bg = ctx.createGain();
      bg.gain.value = 0.050;
      blade.connect(bg).connect(bus);
      blade.start(t);
      oscs.push(blade);

      const h2 = ctx.createOscillator();
      h2.type = 'sine';
      h2.frequency.setValueAtTime(934, t);
      h2.frequency.exponentialRampToValueAtTime(1680, t + duration);
      const hg = ctx.createGain();
      hg.gain.value = 0.016;
      h2.connect(hg).connect(bus);
      h2.start(t);
      oscs.push(h2);

      const n = this._noise();
      const air = ctx.createBiquadFilter();
      air.type = 'bandpass'; air.Q.value = 1.2;
      air.frequency.setValueAtTime(700, t);
      air.frequency.exponentialRampToValueAtTime(1300, t + duration);
      const ag = ctx.createGain();
      ag.gain.setValueAtTime(0.028, t);
      ag.gain.linearRampToValueAtTime(0.050, t + duration);
      n.connect(air).connect(ag).connect(bus);
      n.start(t);

      this.n.hum = { bus, oscs, n, blade };
    } catch { this._fail(); }
  }

  humStop(fade = 0.20) {
    const h = this.n.hum;
    if (!h || !this.ctx) return;
    try {
      const t = this.ctx.currentTime;
      this._fade(h.bus.gain, SILENT, fade);
      // A fan does not stop, it spins down.
      h.blade.frequency.cancelScheduledValues(t);
      h.blade.frequency.linearRampToValueAtTime(h.blade.frequency.value * 0.55, t + fade);
      for (const o of h.oscs) o.stop(t + fade + 0.06);
      h.n.stop(t + fade + 0.06);
    } catch {}
    this.n.hum = null;
  }

  /** A perfect fifth, not a third: a third reads as "well done", a fifth is
      what payment terminals use and reads as "accepted". Deliberately under
      the drawer - this is a shop till, not a fanfare. */
  approve() {
    if (!this.ready || !this.enabled) return;
    const t = this._gate('chime', 0.5);
    if (t === null) return;
    try {
      const ctx = this.ctx;
      // It comes off a speaker behind the terminal glass; it should sound
      // like it.
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass'; lp.frequency.value = 6800; lp.Q.value = 0.7;
      lp.connect(this.place.terminal.in);

      const note = (f, peak, decay, at) => {
        const o = ctx.createOscillator();
        o.type = 'sine';
        o.frequency.value = f;
        const g = ctx.createGain();
        g.gain.value = SILENT;
        this._env(g.gain, t + at, peak, 0.008, decay);
        o.connect(g).connect(lp);
        o.start(t + at);
        this._reap(o, t + at + decay + 0.05);
      };
      note(587.33, 0.078, 0.26, 0);
      note(880.00, 0.031, 0.20, 0);
      note(880.00, 0.095, 0.42, 0.125);
      note(1318.51, 0.038, 0.32, 0.125);
    } catch { this._fail(); }
  }

  /** Four events in 230ms. A drawer that opens and never closes is wrong, so
      the close is the same shape 7dB down and duller - a spring return next
      to a solenoid. */
  drawer(k = 1) {
    if (!this.ready || !this.enabled) return;
    const t = this._gate('drawer', 0.25);
    if (t === null) return;
    try {
      const ctx = this.ctx;
      const dest = this.place.drawer.in;

      // 1. The solenoid plunger hitting its stop, and the only part of this a
      //    laptop speaker will actually reproduce.
      const sol = this._noise();
      const solHp = ctx.createBiquadFilter();
      solHp.type = 'highpass'; solHp.frequency.value = 1600; solHp.Q.value = 0.9;
      const solG = ctx.createGain();
      solG.gain.setValueAtTime(0.09 * k, t);
      solG.gain.exponentialRampToValueAtTime(SILENT, t + 0.022);
      sol.connect(solHp).connect(solG).connect(dest);
      sol.start(t);
      this._reap(sol, t + 0.05);

      // 2. Leaving on its rollers. The pitch falls because the radiating
      //    cavity gets longer as the drawer comes out.
      const roll = this._noise();
      const rollBp = ctx.createBiquadFilter();
      rollBp.type = 'bandpass'; rollBp.Q.value = 0.8;
      rollBp.frequency.setValueAtTime(180, t + 0.006);
      rollBp.frequency.exponentialRampToValueAtTime(90, t + 0.150);
      const rollG = ctx.createGain();
      rollG.gain.value = SILENT;
      this._env(rollG.gain, t + 0.006, 0.05 * k, 0.030, 0.120);
      roll.connect(rollBp).connect(rollG).connect(dest);
      roll.start(t);
      this._reap(roll, t + 0.20);

      // 3. The bell. The hammer sits on the same armature as the plunger and
      //    needs a few milliseconds of travel, so it is struck BEFORE the
      //    drawer lands and rings through everything after. Free-free bar
      //    modes, 1 : 2.756 : 5.404 - inharmonic, which is what makes it
      //    metal rather than an organ. It bypasses the drawer's air filter,
      //    because it is designed to be heard through the counter.
      const bellBus = ctx.createGain();
      bellBus.gain.value = 1;
      const bellLp = ctx.createBiquadFilter();
      bellLp.type = 'lowpass'; bellLp.frequency.value = 6500;
      bellBus.connect(bellLp).connect(this.n.master);
      if (this.n.send) {
        const s = ctx.createGain();
        s.gain.value = 0.30;
        bellLp.connect(s).connect(this.n.send);
      }
      for (const [f, g, d] of [[1860, 0.055, 1.30], [5126, 0.026, 0.60], [10051, 0.010, 0.30]]) {
        const o = ctx.createOscillator();
        o.type = 'sine';
        o.frequency.value = f;
        const og = ctx.createGain();
        og.gain.value = SILENT;
        this._env(og.gain, t + 0.018, g * k, 0.0015, d);
        o.connect(og).connect(bellBus);
        o.start(t + 0.018);
        this._reap(o, t + 0.018 + d + 0.05);
      }
      const ham = this._noise();
      const hamHp = ctx.createBiquadFilter();
      hamHp.type = 'highpass'; hamHp.frequency.value = 5200;
      const hamG = ctx.createGain();
      hamG.gain.setValueAtTime(0.030 * k, t + 0.018);
      hamG.gain.exponentialRampToValueAtTime(SILENT, t + 0.024);
      ham.connect(hamHp).connect(hamG).connect(bellBus);
      ham.start(t + 0.018);
      this._reap(ham, t + 0.05);

      // 4. The end stop. Steel box, plastic till insert.
      const drop = k > 0.6 ? 1 : 0.73;
      for (const [f, peak, decay] of [[132 * drop, 0.21 * k, 0.30], [264 * drop, 0.065 * k, 0.22]]) {
        const o = ctx.createOscillator();
        o.type = 'sine';
        o.frequency.setValueAtTime(f, t + 0.130);
        o.frequency.exponentialRampToValueAtTime(f / 3, t + 0.320);
        const og = ctx.createGain();
        og.gain.value = SILENT;
        this._env(og.gain, t + 0.130, peak, 0.006, decay);
        o.connect(og).connect(dest);
        o.start(t + 0.130);
        this._reap(o, t + 0.130 + decay + 0.05);
      }
      const thud = this._noise();
      const thudBp = ctx.createBiquadFilter();
      thudBp.type = 'bandpass'; thudBp.frequency.value = 900; thudBp.Q.value = 0.7;
      const thudG = ctx.createGain();
      thudG.gain.setValueAtTime(0.08 * k, t + 0.130);
      thudG.gain.exponentialRampToValueAtTime(SILENT, t + 0.175);
      thud.connect(thudBp).connect(thudG).connect(dest);
      thud.start(t + 0.130);
      this._reap(thud, t + 0.20);

      // 5. The tray. Three coin taps as bare scheduled pairs on one gain node
      //    - no extra nodes at all. The bandpass falls as they settle, which
      //    is the difference between coins and a rattling hinge.
      const coin = this._noise();
      const coinBp = ctx.createBiquadFilter();
      coinBp.type = 'bandpass'; coinBp.Q.value = 2.6;
      coinBp.frequency.setValueAtTime(1900, t);
      coinBp.frequency.setTargetAtTime(1150, t + 0.150, 0.05);
      const coinG = ctx.createGain();
      coinG.gain.value = SILENT;
      coinG.gain.setValueAtTime(SILENT, t + 0.138);
      coinG.gain.exponentialRampToValueAtTime(0.09 * k, t + 0.142);
      for (const [at, lvl] of [[0.160, 0.060], [0.182, 0.040], [0.201, 0.025]]) {
        coinG.gain.exponentialRampToValueAtTime(SILENT, t + at - 0.004);
        coinG.gain.exponentialRampToValueAtTime(lvl * k, t + at);
      }
      coinG.gain.exponentialRampToValueAtTime(SILENT, t + 0.228);
      coin.connect(coinBp).connect(coinG).connect(dest);
      coin.start(t);
      this._reap(coin, t + 0.26);
    } catch { this._fail(); }
  }

  /** Two flat buzzes. Because it is a driven transducer the pitch is locked
      to the drive: flat means flat, no bend, and no escalation between
      attempts. The machine does not get angrier - the paper does. */
  decline() {
    if (!this.ready || !this.enabled) return;
    const t = this._gate('decline', 0.5);
    if (t === null) return;
    try {
      const g = this.n.buzz.gain;
      g.cancelScheduledValues(t);
      g.setValueAtTime(SILENT, t);
      for (const at of [t, t + 0.240]) {
        g.setValueAtTime(SILENT, at);
        g.linearRampToValueAtTime(0.125, at + 0.002);
        g.setValueAtTime(0.125, at + 0.147);
        g.linearRampToValueAtTime(SILENT, at + 0.150);
      }
    } catch { this._fail(); }
  }

  /** One sound, then thirty seconds of nothing. The room coming back on
      release is the unlock, and it costs no new voice. */
  lock() {
    if (!this.ready || !this.enabled) return;
    const t = this._gate('lock', 1);
    if (t === null) return;
    try {
      const ctx = this.ctx;
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass'; lp.frequency.value = 1100; lp.Q.value = 1.4;
      lp.connect(this.place.terminal.in);
      for (const [at, peak] of [[0, 0.20], [0.38, 0.16]]) {
        const o = ctx.createOscillator();
        o.type = 'sine';
        o.frequency.setValueAtTime(220, t + at);
        o.frequency.exponentialRampToValueAtTime(196, t + at + 0.30);
        const og = ctx.createGain();
        this._env(og.gain, t + at, peak, 0.008, 0.70);
        o.connect(og).connect(lp);
        o.start(t + at);
        this._reap(o, t + at + 0.80);
      }
    } catch { this._fail(); }
  }

  /** One burst of motor motion per paper row. A 34ms burst against the 46-72ms
      spacing the printer actually uses is roughly a 55% duty cycle, and the
      rhythm comes from the real feed rather than a scheduler - it stutters
      when the loop stutters. */
  printStep(info) {
    if (!this.ready || !this.enabled) return;
    const t = this._gate('step', 0.022);
    if (t === null) return;
    try {
      const whole = Boolean(info && info.whole);
      const len = whole ? 0.190 : 0.034;
      const rise = Math.min(0.016, len * 0.47);

      const f = this.n.motor.frequency;
      f.cancelScheduledValues(t);
      f.setValueAtTime(300, t);
      f.linearRampToValueAtTime(640, t + rise);      // steppers accelerate
      f.linearRampToValueAtTime(470, t + len);       // then settle

      const bf = this.n.motorBody.frequency;
      bf.cancelScheduledValues(t);
      bf.setValueAtTime(1800, t);
      bf.linearRampToValueAtTime(2600, t + rise + 0.004);

      const g = this.n.motorGate.gain;
      g.cancelScheduledValues(t);
      this._env(g, t, 0.145, 0.004, 0.008, Math.max(0.004, len - 0.012));

      const p = this.n.paperGate.gain;
      p.cancelScheduledValues(t);
      this._env(p, t, 0.048, 0.006, len - 0.006);

      // Every step pushes the bed's decay out, so a torn-off receipt simply
      // stops calling and it fades in about 200ms.
      const b = this.n.printBed.gain;
      b.cancelScheduledValues(t);
      b.setValueAtTime(Math.max(b.value, SILENT), t);
      b.linearRampToValueAtTime(0.030, t + 0.02);
      b.setTargetAtTime(SILENT, t + 0.14, 0.06);
    } catch { this._fail(); }
  }

  /** Tearing thermal paper across a serrated bar is a cascade of fibre
      failures, so it is broadband and gets BRIGHTER as it runs. The sweeping
      filter is the whole trick. */
  printerTear() {
    if (!this.ready || !this.enabled) return;
    const t = this._gate('tear', 0.40);
    if (t === null) return;
    try {
      const ctx = this.ctx;
      const dest = this.place.printer.in;

      const n = this._noise();
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass'; bp.Q.value = 1.6;
      bp.frequency.setValueAtTime(1800, t);
      bp.frequency.exponentialRampToValueAtTime(5600, t + 0.130);
      const g = ctx.createGain();
      this._env(g.gain, t, 1.40, 0.006, 0.139);
      n.connect(bp).connect(g).connect(dest);
      n.start(t);
      this._reap(n, t + 0.18);

      // The body knocked by the pull.
      const o = ctx.createOscillator();
      o.type = 'sine';
      o.frequency.setValueAtTime(96, t);
      o.frequency.exponentialRampToValueAtTime(58, t + 0.090);
      const og = ctx.createGain();
      this._env(og.gain, t, 0.14, 0.004, 0.110);
      o.connect(og).connect(dest);
      o.start(t);
      this._reap(o, t + 0.16);
    } catch { this._fail(); }
  }

  /** Not in the original table. The bag is the only object on the right-hand
      third of the frame, and without it the idle loop has no journey: a beep
      at the scanner, a second and a half of travel, paper away to the right.
      The set moves left to right and you can hear it with your eyes closed. */
  bag() {
    if (!this.ready || !this.enabled || this.voices >= VOICE_CAP) return;
    const t = this._gate('bag', 0.26);
    if (t === null) return;
    try {
      const ctx = this.ctx;
      const n = this._noise();
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass'; bp.Q.value = 0.9;
      bp.frequency.setValueAtTime(2900, t);
      bp.frequency.exponentialRampToValueAtTime(1600, t + 0.240);
      const g = ctx.createGain();
      g.gain.setValueAtTime(SILENT, t);
      g.gain.exponentialRampToValueAtTime(0.62, t + 0.030);
      // Two notches during the decay - the difference between a crinkle and
      // a shush.
      g.gain.setValueAtTime(0.36, t + 0.070);
      g.gain.setValueAtTime(0.50, t + 0.140);
      g.gain.exponentialRampToValueAtTime(SILENT, t + 0.260);
      n.connect(bp).connect(g).connect(this.place.bag.in);
      n.start(t);
      this._reap(n, t + 0.30);
    } catch { this._fail(); }
  }

  /* ---------------------------------------------------------------- *
   * The counter's states, in sound. Two of them are defined by what
   * stops rather than by what starts.
   * ---------------------------------------------------------------- */
  setState(name, { silent = false } = {}) {
    this.state = name;
    if (!this.ready || !this.enabled) return;
    try {
      this._reframe();
      const t = this.ctx.currentTime;
      const to = (g, v, tau) => g.gain.setTargetAtTime(Math.max(v, SILENT), t, tau);
      const moving = ['idle', 'held', 'entering', 'approved'].includes(name);
      this._belt(moving ? 1 : 0);

      if (name === 'authorising') {
        to(this.n.room, SILENT, 0.09);
        to(this.n.term, BED_TERM, 0.20);
        if (!silent) this.humStart(2.35);
        return;
      }
      this.humStop(name === 'approved' ? 0.10 : 0.20);

      if (name === 'locked') {
        to(this.n.room, SILENT, 0.34);
        to(this.n.term, SILENT, 0.40);
        if (!silent) this.lock();
        return;
      }

      to(this.n.room, BED_ROOM, 0.28);
      to(this.n.term, BED_TERM, 0.28);
      if (silent) return;
      if (name === 'entering') this.tick();
      if (name === 'approved') this.approve();   // the chime only; the drawer
      if (name === 'declined') this.decline();   // arrives 220ms later
    } catch { this._fail(); }
  }

  /** The printer and the reader are hidden below 760px while the printer's
      step loop still runs, so without this the whirr plays for an invisible
      machine. Checked once per state change, never per sound.

      getClientRects(), not offsetParent: the belt is position: fixed and a
      fixed element's offsetParent is ALWAYS null, so that test would mute the
      belt bed permanently on the desktop layout where the belt is the most
      visible thing on the page. Rects also come back empty when an ancestor
      is display: none, which offsetParent alone does not tell you. */
  _rendered(el) { return Boolean(el && el.getClientRects().length); }

  _reframe() {
    if (!this.ready) return;
    const show = (p, sel) => {
      if (p) p.dry.gain.value = this._rendered(document.querySelector(sel)) ? p.base : SILENT;
    };
    show(this.place.printer, '.printer');
    show(this.place.reader, '.reader');
    this.n.beltVisible = this._rendered(document.querySelector('.lane-belt'));
  }

  /* ---------------------------------------------------------------- *
   * An AudioContext keeps running in a hidden tab - audio is one of the
   * reasons a tab is not throttled - while the scene's animation loop
   * starves. Without this the room tone plays on over a frozen set and
   * the browser lights the tab's audio indicator on a page that looks
   * dead.
   * ---------------------------------------------------------------- */
  setVisible(visible) {
    if (!this.ctx || !this.enabled) return;
    if (visible) {
      this.ctx.resume();
      // The layout may have changed while nobody was looking, and the beds are
      // only re-evaluated on a state change - which might not come for a while.
      this._reframe();
      this._belt(['idle', 'held', 'entering', 'approved'].includes(this.state) ? 1 : 0);
      this._fade(this.n.master.gain, MASTER_ON, 0.40);
    } else {
      this._fade(this.n.master.gain, SILENT, 0.12);
      // Suspend after the fade, or it freezes half-done and clicks.
      setTimeout(() => { if (document.hidden) this.ctx?.suspend(); }, 170);
    }
  }

  /** Safari has a fourth state the spec does not: interrupted, for a phone
      call or the page losing audio focus. A context that goes away under a
      pressed toggle has to come back on its own, or on the next gesture. */
  _recover() {
    if (!this.enabled || document.hidden || !this.ctx) return;
    const s = this.ctx.state;
    if (s === 'closed') { this.ctx = null; this.ready = false; return; }
    if (s !== 'suspended' && s !== 'interrupted') return;
    this.ctx.resume();
    setTimeout(() => {
      if (this.ctx?.state === 'running' || !this.enabled) return;
      const go = () => { this.ctx?.resume(); };   // makes no sound of its own
      addEventListener('pointerdown', go, { once: true });
      addEventListener('keydown', go, { once: true });
    }, 300);
  }
}
