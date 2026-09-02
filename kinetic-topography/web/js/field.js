// The Kinetic Topography field: a GPU particle simulation plus its post chain.
//
// Architecture
//   sim      : ping-pong MRT over two RGBA32F textures (position, velocity).
//              Every visual "formation" is a target field the particles spring
//              toward, so switching state is a physical migration, not a cut.
//   scene    : HDR ping-pong with per-frame decay = trails, for free.
//   bloom    : soft-knee bright pass -> 3-level separable gaussian.
//   composite: chromatic aberration, glitch, ACES tonemap, vignette, grain.

import * as M from './math.js';
import * as G from './glutil.js';
import {
  SIM_FS, POINT_VS, POINT_FS, FEEDBACK_FS,
  BRIGHT_FS, BLUR_FS, COMPOSITE_FS,
} from './shaders.js';

const TAU = Math.PI * 2;
const PANEL_DIST = 6.0;      // world distance from camera to the glass plane
const FOV = 52 * Math.PI / 180;

export const QUALITY = { low: 256, medium: 384, high: 512 };

// Per-mode physics and look. Underdamped stiffness (reassemble) is what makes
// the panel snap back and shudder rather than glide politely into place.
//
// `decay` and `bright` are coupled: the trail buffer accumulates roughly
// 1/(1-decay) frames of light, so a mode with long trails (warp, 0.968 -> 31x)
// needs a far smaller per-particle brightness than one with short trails.
// Likewise `point` and `bright` trade off against how tightly the formation
// packs - the gyroscope holds every particle in a few world units, the
// topography spreads them over ninety.
const MODES = {
  idle:       { id: 0, stiff: 3.4,  damp: 2.8, noise: 0.42, decay: 0.790, bloom: 1.15, exposure: 1.00, point: 27, shard: 0.30, crest: 1.00, snap: 0, bright: 1.45 },
  focus:      { id: 1, stiff: 4.4,  damp: 3.0, noise: 0.55, decay: 0.735, bloom: 1.30, exposure: 1.06, point: 28, shard: 0.42, crest: 1.00, snap: 0, bright: 1.45 },
  auth:       { id: 2, stiff: 15.0, damp: 4.4, noise: 0.55, decay: 0.880, bloom: 1.20, exposure: 1.10, point: 9, shard: 1.00, crest: 0.00, snap: 45, bright: 0.20 },
  align:      { id: 3, stiff: 30.0, damp: 7.0, noise: 0.12, decay: 0.900, bloom: 1.70, exposure: 1.12, point: 10, shard: 1.00, crest: 0.00, snap: 70, bright: 0.17 },
  warp:       { id: 4, stiff: 0.0,  damp: 0.3, noise: 0.40, decay: 0.968, bloom: 1.80, exposure: 1.10, point: 16, shard: 1.00, crest: 0.00, snap: 0, bright: 0.07 },
  ambient:    { id: 5, stiff: 2.4,  damp: 2.6, noise: 0.34, decay: 0.770, bloom: 0.80, exposure: 0.82, point: 23, shard: 0.22, crest: 1.00, snap: 0, bright: 1.25 },
  halt:       { id: 6, stiff: 2.4,  damp: 9.5, noise: 0.30, decay: 0.800, bloom: 1.45, exposure: 1.05, point: 9, shard: 1.00, crest: 0.00, snap: 22, bright: 0.20 },
  dust:       { id: 7, stiff: 0.0,  damp: 1.2, noise: 2.30, decay: 0.900, bloom: 1.70, exposure: 1.06, point: 13, shard: 1.00, crest: 0.00, snap: 0, bright: 0.30 },
  reassemble: { id: 8, stiff: 24.0, damp: 3.1, noise: 0.50, decay: 0.830, bloom: 1.25, exposure: 1.04, point: 28, shard: 0.75, crest: 0.85, snap: 0, bright: 0.42 },
};

export const PALETTE = {
  calm:    { lo: [0.020, 0.185, 0.300], hi: [0.350, 0.950, 1.000], amb: [0.010, 0.030, 0.048] },
  kinetic: { lo: [0.130, 0.050, 0.340], hi: [0.720, 0.420, 1.000], amb: [0.030, 0.014, 0.055] },
  success: { lo: [0.040, 0.300, 0.280], hi: [1.000, 0.820, 0.420], amb: [0.020, 0.045, 0.045] },
  failure: { lo: [0.240, 0.020, 0.045], hi: [1.000, 0.220, 0.260], amb: [0.055, 0.008, 0.012] },
};

const mix3 = (a, b, t) => [
  a[0] + (b[0] - a[0]) * t,
  a[1] + (b[1] - a[1]) * t,
  a[2] + (b[2] - a[2]) * t,
];

export class KineticField {
  constructor(canvas, { quality = 'high' } = {}) {
    this.canvas = canvas;
    const gl = canvas.getContext('webgl2', {
      alpha: false, antialias: false, depth: false, stencil: false,
      premultipliedAlpha: false, powerPreference: 'high-performance',
      preserveDrawingBuffer: false, desynchronized: true,
    });
    if (!gl) throw new Error('WebGL2 unavailable');
    this.gl = gl;

    this.floatRT = !!gl.getExtension('EXT_color_buffer_float');
    this.halfRT = this.floatRT || !!gl.getExtension('EXT_color_buffer_half_float');
    if (!this.halfRT) throw new Error('float render targets unavailable');
    gl.getExtension('OES_texture_float_linear');

    this.size = QUALITY[quality] || QUALITY.high;
    this.renderScale = 1;
    this.dprCap = 1.6;

    // ---- live state -------------------------------------------------
    this.time = 0;
    this.mode = 'idle';
    this.modeT = 0;
    this.p = { ...MODES.idle };          // smoothed toward MODES[mode]
    this.energy = 0;      this.energyT = 0;
    this.orbit = 0;       this.orbitT = 0;
    this.align = 0;       this.alignT = 0;
    this.gyroPull = 0;    this.gyroPullT = 0;
    this.warp = 0;        this.warpT = 0;
    this.glitch = 0;      this.glitchT = 0;
    this.flash = 0;
    this.flashCol = [1, 1, 1];
    this.shatter = 0;
    this.gyroPhase = 0;   this.gyroSpin = 0; this.gyroSpinT = 0;
    this.mouseAmt = 0;    this.mouseAmtT = 0;
    this.mousePol = 1;
    this.dolly = 0;       this.dollyT = 0;   // 0 = idle framing, 1 = pushed in
    this.exposureBias = 1;

    this.colLo = [...PALETTE.calm.lo];
    this.colHi = [...PALETTE.calm.hi];
    this.amb = [...PALETTE.calm.amb];
    this.colLoT = [...PALETTE.calm.lo];
    this.colHiT = [...PALETTE.calm.hi];
    this.ambT = [...PALETTE.calm.amb];

    this.waves = new Float32Array(32).fill(0);
    for (let i = 0; i < 8; i++) this.waves[i * 4 + 3] = -1;
    this.waveAmp = new Float32Array(8);
    this.waveSlot = 0;

    // ---- camera -----------------------------------------------------
    this.eye = M.v3(0, 2.4, 13.0);
    this.look = M.v3(0, -0.9, 0.0);
    this.camFwd = M.v3(0, 0, -1);
    this.camRight = M.v3(1, 0, 0);
    this.camUp = M.v3(0, 1, 0);
    this.parallax = { x: 0, y: 0, tx: 0, ty: 0 };
    this.view = M.mat4();
    this.proj = M.mat4();
    this.viewProj = M.mat4();

    // ---- panel basis (world-space frame of the DOM glass panel) -----
    this.panelC = M.v3(0, 0, 3.2);
    this.panelR = M.v3(1.4, 0, 0);
    this.panelU = M.v3(0, 1.8, 0);
    this.panelN = M.v3(0, 0, -1);
    this.gyroC = M.v3(0, 1.1, 3.3);
    this.panelEl = null;
    this.panelFrozen = false;

    this.mouseNdc = { x: 0, y: 0 };
    this.mouseWorld = M.v3(0, 0, 0);

    this._buildPrograms();
    this._buildSim();
    this._resize(true);
  }

  // ------------------------------------------------------------------
  // Setup
  // ------------------------------------------------------------------
  _buildPrograms() {
    const gl = this.gl;
    this.progSim = G.program(gl, G.FULLSCREEN_VS, SIM_FS, 'sim');
    this.progPoints = G.program(gl, POINT_VS, POINT_FS, 'points');
    this.progFeedback = G.program(gl, G.FULLSCREEN_VS, FEEDBACK_FS, 'feedback');
    this.progBright = G.program(gl, G.FULLSCREEN_VS, BRIGHT_FS, 'bright');
    this.progBlur = G.program(gl, G.FULLSCREEN_VS, BLUR_FS, 'blur');
    this.progComposite = G.program(gl, G.FULLSCREEN_VS, COMPOSITE_FS, 'composite');
    this.vao = gl.createVertexArray();   // attributeless draws still need a VAO
  }

  _buildSim() {
    const gl = this.gl;
    const N = this.size;
    const internal = this.floatRT ? gl.RGBA32F : gl.RGBA16F;
    const type = this.floatRT ? gl.FLOAT : gl.HALF_FLOAT;

    // Seed the field scattered through a large volume: the first seconds are
    // the particles assembling themselves into the topography, which doubles
    // as the page's entrance animation.
    const data = new Float32Array(N * N * 4);
    for (let i = 0; i < N * N; i++) {
      // Kept entirely in front of the camera so nothing starts as a giant blob.
      data[i * 4 + 0] = (Math.random() - 0.5) * 70;
      data[i * 4 + 1] = (Math.random() - 0.5) * 26 - 3;
      data[i * 4 + 2] = 4 - Math.random() * 70;
      data[i * 4 + 3] = Math.random();          // seed: > SHARD_CUT => panel shard
    }
    this.sim = [0, 1].map((k) => {
      const pos = G.texture(gl, N, N, internal, gl.RGBA, type,
        this.floatRT && k === 0 ? data : null);
      const vel = G.texture(gl, N, N, internal, gl.RGBA, type, null);
      return { pos, vel, fb: G.framebuffer(gl, [pos, vel]) };
    });
    this.simIdx = 0;

    if (!this.floatRT) {
      // Half-float upload path: convert once via a staging float32 -> the
      // driver handles the narrowing for us through texSubImage with FLOAT.
      gl.bindTexture(gl.TEXTURE_2D, this.sim[0].pos);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, N, N, gl.RGBA, gl.FLOAT, data);
      gl.bindTexture(gl.TEXTURE_2D, null);
    }

    // Clear velocities in both buffers so nothing starts with garbage.
    for (const s of this.sim) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, s.fb);
      gl.viewport(0, 0, N, N);
      gl.drawBuffers([gl.NONE, gl.COLOR_ATTACHMENT1]);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1]);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this.count = N * N;
  }

  setQuality(name) {
    const next = QUALITY[name];
    if (!next || next === this.size) return;
    const gl = this.gl;
    for (const s of this.sim) {
      gl.deleteTexture(s.pos); gl.deleteTexture(s.vel); gl.deleteFramebuffer(s.fb);
    }
    this.size = next;
    this._buildSim();
  }

  _resize(force = false) {
    const gl = this.gl;
    const dpr = Math.min(window.devicePixelRatio || 1, this.dprCap) * this.renderScale;
    const w = Math.max(2, Math.round(this.canvas.clientWidth * dpr));
    const h = Math.max(2, Math.round(this.canvas.clientHeight * dpr));
    if (!force && w === this.canvas.width && h === this.canvas.height) return;

    this.canvas.width = w; this.canvas.height = h;
    this.W = w; this.H = h;

    const old = [...(this.rts || [])];
    for (const rt of old) { gl.deleteTexture(rt.tex); gl.deleteFramebuffer(rt.fb); }

    this.scene = [G.renderTarget(gl, w, h), G.renderTarget(gl, w, h)];
    this.sceneIdx = 0;
    this.bloom = [];
    for (let i = 0; i < 3; i++) {
      const s = 1 << (i + 1);
      const bw = Math.max(2, Math.floor(w / s));
      const bh = Math.max(2, Math.floor(h / s));
      this.bloom.push({ a: G.renderTarget(gl, bw, bh), b: G.renderTarget(gl, bw, bh) });
    }
    this.rts = [...this.scene, ...this.bloom.flatMap((b) => [b.a, b.b])];

    // Clear the trail buffers so a resize does not smear the old frame.
    for (const rt of this.scene) {
      G.bindRT(gl, rt);
      gl.clearColor(0, 0, 0, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  // ------------------------------------------------------------------
  // Public control surface
  // ------------------------------------------------------------------
  setMode(name) {
    if (!MODES[name] || name === this.mode) return;
    this.mode = name;
    this.modeT = 0;
  }

  setPanelElement(el) { this.panelEl = el; }
  freezePanel(v = true) { this.panelFrozen = v; }

  setEnergy(v) { this.energyT = M.clamp(v, 0, 1); }
  setOrbit(v) { this.orbitT = M.clamp(v, 0, 1); }
  setAlign(v) { this.alignT = M.clamp(v, 0, 1); }
  setGyroPull(v) { this.gyroPullT = M.clamp(v, 0, 1); }
  setGyroSpin(v) { this.gyroSpinT = v; }
  setWarp(v) { this.warpT = M.clamp(v, 0, 1); }
  setGlitch(v) { this.glitchT = M.clamp(v, 0, 1); }
  setDolly(v) { this.dollyT = M.clamp(v, 0, 1); }
  setMouseInfluence(v) { this.mouseAmtT = M.clamp(v, 0, 1); }
  setMousePolarity(v) { this.mousePol = v; }
  setExposureBias(v) { this.exposureBias = v; }

  /** Snap the gyroscope rotation to a hard stop (the "gear jam"). */
  jamGyro() { this.gyroSpin = 0; this.gyroSpinT = 0; }

  setPalette(name, t = 1) {
    const pal = PALETTE[name] || PALETTE.calm;
    this.colLoT = mix3(this.colLoT, pal.lo, t);
    this.colHiT = mix3(this.colHiT, pal.hi, t);
    this.ambT = mix3(this.ambT, pal.amb, t);
  }

  /** Blend between two named palettes; used for the cyan -> violet ramp. */
  blendPalette(a, b, t) {
    const A = PALETTE[a], B = PALETTE[b];
    this.colLoT = mix3(A.lo, B.lo, t);
    this.colHiT = mix3(A.hi, B.hi, t);
    this.ambT = mix3(A.amb, B.amb, t);
  }

  flashOut(amount, color) {
    this.flash = amount;
    if (color) this.flashCol = color;
  }

  shatterPanel(amount = 1) { this.shatter = amount; }

  /** Emit a shockwave. Defaults to the panel centre. */
  pulse(strength = 1, world = null) {
    const i = this.waveSlot % 8;
    this.waveSlot++;
    const p = world && Number.isFinite(world[0] + world[1] + world[2]) ? world : this.panelC;
    this.waves[i * 4 + 0] = p[0];
    this.waves[i * 4 + 1] = p[1];
    this.waves[i * 4 + 2] = p[2];
    this.waves[i * 4 + 3] = this.time;
    this.waveAmp[i] = strength;
  }

  /** Shockwave anchored at a DOM element's centre. */
  pulseAtElement(el, strength = 1) {
    if (!el) return this.pulse(strength);
    const r = el.getBoundingClientRect();
    this.pulse(strength, this._screenToPanelPlane(r.left + r.width / 2, r.top + r.height / 2));
  }

  setPointer(clientX, clientY) {
    const { w, h } = this._cssSize();
    this.mouseNdc.x = (clientX / w) * 2 - 1;
    this.mouseNdc.y = 1 - (clientY / h) * 2;
    this.parallax.tx = this.mouseNdc.x;
    this.parallax.ty = this.mouseNdc.y;
  }

  // ------------------------------------------------------------------
  // Camera + panel geometry
  // ------------------------------------------------------------------
  /** CSS pixel size of the canvas, never zero: a hidden or collapsed canvas
   *  reports 0 and every ndc calculation downstream would become NaN. */
  _cssSize() {
    return {
      w: this.canvas.clientWidth || this.canvas.width || 1,
      h: this.canvas.clientHeight || this.canvas.height || 1,
    };
  }

  /** Returns null when the canvas has no layout size - callers fall back to
   *  the panel centre rather than deriving a meaningless world point. */
  _screenToPanelPlane(clientX, clientY) {
    if (!this.canvas.clientWidth || !this.canvas.clientHeight) return null;
    const { w, h } = this._cssSize();
    const ndcX = (clientX / w) * 2 - 1;
    const ndcY = 1 - (clientY / h) * 2;
    const halfH = PANEL_DIST * Math.tan(FOV / 2);
    const halfW = halfH * (w / h);
    const out = M.v3();
    for (let i = 0; i < 3; i++) {
      out[i] = this.eye[i] + this.camFwd[i] * PANEL_DIST
             + this.camRight[i] * (ndcX * halfW) + this.camUp[i] * (ndcY * halfH);
    }
    return out;
  }

  _updateCamera(dt) {
    // Idle framing, pushed forward toward the gyroscope as `dolly` rises.
    const px = M.approach(this.parallax.x, this.parallax.tx, 2.2, dt);
    const py = M.approach(this.parallax.y, this.parallax.ty, 2.2, dt);
    this.parallax.x = px; this.parallax.y = py;

    const sway = 1 - this.dolly;
    const baseEye = [
      px * 0.55 * sway,
      2.4 + py * 0.38 * sway,
      13.0,
    ];
    const baseLook = [px * 0.22 * sway, -0.9 + py * 0.16 * sway, 0.0];

    // Dolly interpolates the eye toward the frozen gyroscope centre.
    const gz = this.gyroC;
    const dist = M.lerp(PANEL_DIST, 2.1, this.dolly);
    const f = M.norm(M.v3(), M.sub(M.v3(), baseLook, baseEye));
    const dollyEye = [gz[0] - f[0] * dist, gz[1] - f[1] * dist, gz[2] - f[2] * dist];

    for (let i = 0; i < 3; i++) {
      this.eye[i] = M.lerp(baseEye[i], dollyEye[i], this.dolly);
      this.look[i] = M.lerp(baseLook[i], gz[i], this.dolly);
    }

    M.norm(this.camFwd, M.sub(M.v3(), this.look, this.eye));
    M.norm(this.camRight, M.cross(M.v3(), this.camFwd, M.v3(0, 1, 0)));
    M.cross(this.camUp, this.camRight, this.camFwd);

    const aspect = this.W / this.H;
    M.perspective(this.proj, FOV, aspect, 0.08, 260);
    M.lookAt(this.view, this.eye, this.look, M.v3(0, 1, 0));
    M.multiply(this.viewProj, this.proj, this.view);

    // Project the DOM panel rect onto the plane PANEL_DIST in front of us.
    if (this.panelEl && !this.panelFrozen) {
      const r = this.panelEl.getBoundingClientRect();
      const { w, h } = this._cssSize();
      if (r.width > 0 && r.height > 0) {
        const cx = ((r.left + r.width / 2) / w) * 2 - 1;
        const cy = 1 - ((r.top + r.height / 2) / h) * 2;
        const hx = r.width / w;
        const hy = r.height / h;
        const halfH = PANEL_DIST * Math.tan(FOV / 2);
        const halfW = halfH * (w / h);
        for (let i = 0; i < 3; i++) {
          this.panelC[i] = this.eye[i] + this.camFwd[i] * PANEL_DIST
                         + this.camRight[i] * (cx * halfW) + this.camUp[i] * (cy * halfH);
          this.panelR[i] = this.camRight[i] * (hx * halfW);
          this.panelU[i] = this.camUp[i] * (hy * halfH);
          this.panelN[i] = this.camFwd[i];
        }
      }
    }
    // The gyroscope inherits the panel's position the moment we submit.
    if (!this.panelFrozen) {
      this.gyroC[0] = this.panelC[0]; this.gyroC[1] = this.panelC[1]; this.gyroC[2] = this.panelC[2];
    }

    // Cursor magnet: intersect the pointer ray with the ocean plane.
    const t = Math.tan(FOV / 2);
    const dir = M.v3();
    for (let i = 0; i < 3; i++) {
      dir[i] = this.camFwd[i]
             + this.camRight[i] * (this.mouseNdc.x * t * aspect)
             + this.camUp[i] * (this.mouseNdc.y * t);
    }
    M.norm(dir, dir);
    const planeY = -3.0;
    let k = dir[1] < -1e-4 ? (planeY - this.eye[1]) / dir[1] : -1;
    if (k < 0 || k > 46) k = 14;
    for (let i = 0; i < 3; i++) this.mouseWorld[i] = this.eye[i] + dir[i] * k;
  }

  // ------------------------------------------------------------------
  // Frame
  // ------------------------------------------------------------------
  frame(dtRaw) {
    const gl = this.gl;
    const dt = Math.min(dtRaw, 1 / 20);
    this.time += dt;
    this.modeT += dt;
    this._resize();

    // Ease every driven scalar so nothing ever pops.
    const M_ = MODES[this.mode];
    for (const k of ['stiff', 'damp', 'noise', 'decay', 'bloom', 'exposure', 'point', 'shard', 'crest', 'snap', 'bright']) {
      this.p[k] = M.approach(this.p[k], M_[k], 6.5, dt);
    }
    this.energy = M.approach(this.energy, this.energyT, 5.0, dt);
    this.orbit = M.approach(this.orbit, this.orbitT, 3.2, dt);
    this.align = M.approach(this.align, this.alignT, 7.0, dt);
    this.gyroPull = M.approach(this.gyroPull, this.gyroPullT, 3.0, dt);
    this.warp = M.approach(this.warp, this.warpT, 8.0, dt);
    this.glitch = M.approach(this.glitch, this.glitchT, 14.0, dt);
    this.dolly = M.approach(this.dolly, this.dollyT, 2.4, dt);
    this.mouseAmt = M.approach(this.mouseAmt, this.mouseAmtT, 4.0, dt);
    this.gyroSpin = M.approach(this.gyroSpin, this.gyroSpinT, 2.6, dt);
    this.gyroPhase += this.gyroSpin * dt;
    this.flash *= Math.exp(-dt * 6.2);
    this.shatter *= Math.exp(-dt * 9.0);
    if (this.shatter < 0.002) this.shatter = 0;

    this.colLo = mix3(this.colLo, this.colLoT, 1 - Math.exp(-3.4 * dt));
    this.colHi = mix3(this.colHi, this.colHiT, 1 - Math.exp(-3.4 * dt));
    this.amb = mix3(this.amb, this.ambT, 1 - Math.exp(-3.4 * dt));

    this._updateCamera(dt);

    gl.bindVertexArray(this.vao);
    this._simulate(dt);
    this._drawScene();
    this._bloom();
    this._composite();
    gl.bindVertexArray(null);
  }

  _simulate(dt) {
    const gl = this.gl;
    const src = this.sim[this.simIdx];
    const dst = this.sim[1 - this.simIdx];
    const { p, u } = this.progSim;

    gl.bindFramebuffer(gl.FRAMEBUFFER, dst.fb);
    gl.viewport(0, 0, this.size, this.size);
    gl.disable(gl.BLEND);
    gl.useProgram(p);

    G.bindTex(gl, 0, src.pos, u.uPos);
    G.bindTex(gl, 1, src.vel, u.uVel);
    gl.uniform2f(u.uField, this.size, this.size);
    gl.uniform1f(u.uTime, this.time);
    gl.uniform1f(u.uDt, dt);
    gl.uniform1i(u.uMode, MODES[this.mode].id);
    gl.uniform1f(u.uStiff, this.p.stiff);
    gl.uniform1f(u.uDamp, this.p.damp);
    gl.uniform1f(u.uNoiseAmp, this.p.noise);
    gl.uniform1f(u.uOrbit, this.orbit);
    gl.uniform1f(u.uEnergy, this.energy);
    gl.uniform1f(u.uAlign, this.align);
    gl.uniform1f(u.uGyroT, this.gyroPhase);
    gl.uniform1f(u.uGyroPull, this.gyroPull);
    gl.uniform1f(u.uWarp, this.warp);
    gl.uniform1f(u.uShatter, this.shatter);
    gl.uniform3fv(u.uGyroC, this.gyroC);
    gl.uniform3fv(u.uPanelC, this.panelC);
    gl.uniform3fv(u.uPanelR, this.panelR);
    gl.uniform3fv(u.uPanelU, this.panelU);
    gl.uniform3fv(u.uPanelN, this.panelN);
    gl.uniform3fv(u.uCamPos, this.eye);
    gl.uniform3fv(u.uCamFwd, this.camFwd);
    gl.uniform3fv(u.uCamRight, this.camRight);
    gl.uniform3fv(u.uCamUp, this.camUp);
    gl.uniform3fv(u.uMouseP, this.mouseWorld);
    gl.uniform1f(u.uMouseAmt, this.mouseAmt);
    gl.uniform1f(u.uMousePol, this.mousePol);
    gl.uniform4fv(u.uWaves, this.waves);
    gl.uniform1fv(u.uWaveAmp, this.waveAmp);
    gl.uniform1f(u.uSpreadK, 2 * Math.tan(FOV / 2) * (this.W / this.H) * 1.03);
    gl.uniform1f(u.uSnapRate, this.p.snap);

    gl.drawArrays(gl.TRIANGLES, 0, 3);
    this.simIdx = 1 - this.simIdx;
  }

  _drawScene() {
    const gl = this.gl;
    const prev = this.scene[this.sceneIdx];
    const cur = this.scene[1 - this.sceneIdx];

    G.bindRT(gl, cur);
    gl.disable(gl.BLEND);

    // Trail feedback: last frame, faded and very slightly zoomed.
    {
      const { p, u } = this.progFeedback;
      gl.useProgram(p);
      G.bindTex(gl, 0, prev.tex, u.uPrev);
      gl.uniform1f(u.uDecay, this.p.decay);
      const z = M.lerp(1.0, 0.994, this.warp);
      gl.uniform2f(u.uZoom, z, z);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }

    // Particles, additively.
    {
      const { p, u } = this.progPoints;
      gl.useProgram(p);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE);
      const s = this.sim[this.simIdx];
      G.bindTex(gl, 0, s.pos, u.uPos);
      G.bindTex(gl, 1, s.vel, u.uVel);
      gl.uniformMatrix4fv(u.uViewProj, false, this.viewProj);
      gl.uniform1i(u.uSize, this.size);
      gl.uniform3fv(u.uCamPos, this.eye);
      gl.uniform3fv(u.uColLo, this.colLo);
      gl.uniform3fv(u.uColHi, this.colHi);
      // Keep apparent point size stable across resolutions and densities.
      // Scaling by sqrt(W*H) rather than H alone matters: additive overdraw
      // goes as pointArea/screenArea, so a height-only scale makes narrow
      // viewports noticeably brighter than wide ones at the same settings.
      const density = 512 / this.size;
      const res = Math.sqrt(this.W * this.H) / Math.sqrt(1440 * 900);
      gl.uniform1f(u.uPointScale, this.p.point * res * density);
      gl.uniform1f(u.uBrightness, this.p.bright);
      gl.uniform1f(u.uCrest, this.p.crest);
      gl.uniform1f(u.uShardBoost, this.p.shard);
      gl.uniform1f(u.uTime, this.time);
      gl.drawArrays(gl.POINTS, 0, this.count);
      gl.disable(gl.BLEND);
    }

    this.sceneIdx = 1 - this.sceneIdx;
  }

  _bloom() {
    const gl = this.gl;
    const scene = this.scene[this.sceneIdx];

    {
      const { p, u } = this.progBright;
      gl.useProgram(p);
      G.bindRT(gl, this.bloom[0].a);
      G.bindTex(gl, 0, scene.tex, u.uSrc);
      gl.uniform1f(u.uThreshold, 0.55);
      gl.uniform1f(u.uKnee, 0.35);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }

    const { p, u } = this.progBlur;
    gl.useProgram(p);
    for (let i = 0; i < this.bloom.length; i++) {
      const lvl = this.bloom[i];
      if (i > 0) {
        // Downsample from the previous level's result.
        G.bindRT(gl, lvl.a);
        G.bindTex(gl, 0, this.bloom[i - 1].a.tex, u.uSrc);
        gl.uniform2f(u.uDir, 0, 0);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
      }
      G.bindRT(gl, lvl.b);
      G.bindTex(gl, 0, lvl.a.tex, u.uSrc);
      gl.uniform2f(u.uDir, 1 / lvl.a.w, 0);
      gl.drawArrays(gl.TRIANGLES, 0, 3);

      G.bindRT(gl, lvl.a);
      G.bindTex(gl, 0, lvl.b.tex, u.uSrc);
      gl.uniform2f(u.uDir, 0, 1 / lvl.b.h);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }
  }

  _composite() {
    const gl = this.gl;
    const { p, u } = this.progComposite;
    gl.useProgram(p);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.W, this.H);
    gl.disable(gl.BLEND);

    G.bindTex(gl, 0, this.scene[this.sceneIdx].tex, u.uScene);
    G.bindTex(gl, 1, this.bloom[0].a.tex, u.uBloom0);
    G.bindTex(gl, 2, this.bloom[1].a.tex, u.uBloom1);
    G.bindTex(gl, 3, this.bloom[2].a.tex, u.uBloom2);
    gl.uniform1f(u.uBloomAmt, this.p.bloom);
    gl.uniform1f(u.uExposure, this.p.exposure * this.exposureBias);
    gl.uniform1f(u.uCA, 0.0016);
    gl.uniform1f(u.uGlitch, this.glitch);
    gl.uniform1f(u.uFlash, this.flash);
    gl.uniform3fv(u.uFlashCol, this.flashCol);
    gl.uniform3fv(u.uAmbient, this.amb);
    gl.uniform1f(u.uTime, this.time);
    gl.uniform1f(u.uVignette, 0.85);
    gl.uniform1f(u.uGrain, 0.028);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }
}
