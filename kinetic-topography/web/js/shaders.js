// All GLSL for the field. WebGL2 / GLSL ES 3.00.

/* 3D simplex noise: Ashima Arts / Stefan Gustavson, MIT licensed.
   Used for the topographic heightfield and for curl-ish turbulence. */
const NOISE = `
vec3 mod289(vec3 x){ return x - floor(x*(1.0/289.0))*289.0; }
vec4 mod289(vec4 x){ return x - floor(x*(1.0/289.0))*289.0; }
vec4 permute(vec4 x){ return mod289(((x*34.0)+1.0)*x); }
vec4 taylorInvSqrt(vec4 r){ return 1.79284291400159 - 0.85373472095314*r; }
float snoise(vec3 v){
  const vec2 C = vec2(1.0/6.0, 1.0/3.0);
  const vec4 D = vec4(0.0, 0.5, 1.0, 2.0);
  vec3 i  = floor(v + dot(v, C.yyy));
  vec3 x0 = v - i + dot(i, C.xxx);
  vec3 g = step(x0.yzx, x0.xyz);
  vec3 l = 1.0 - g;
  vec3 i1 = min(g.xyz, l.zxy);
  vec3 i2 = max(g.xyz, l.zxy);
  vec3 x1 = x0 - i1 + C.xxx;
  vec3 x2 = x0 - i2 + C.yyy;
  vec3 x3 = x0 - D.yyy;
  i = mod289(i);
  vec4 p = permute(permute(permute(
             i.z + vec4(0.0, i1.z, i2.z, 1.0))
           + i.y + vec4(0.0, i1.y, i2.y, 1.0))
           + i.x + vec4(0.0, i1.x, i2.x, 1.0));
  float n_ = 0.142857142857;
  vec3 ns = n_ * D.wyz - D.xzx;
  vec4 j = p - 49.0 * floor(p * ns.z * ns.z);
  vec4 x_ = floor(j * ns.z);
  vec4 y_ = floor(j - 7.0 * x_);
  vec4 x = x_ * ns.x + ns.yyyy;
  vec4 y = y_ * ns.x + ns.yyyy;
  vec4 h = 1.0 - abs(x) - abs(y);
  vec4 b0 = vec4(x.xy, y.xy);
  vec4 b1 = vec4(x.zw, y.zw);
  vec4 s0 = floor(b0)*2.0 + 1.0;
  vec4 s1 = floor(b1)*2.0 + 1.0;
  vec4 sh = -step(h, vec4(0.0));
  vec4 a0 = b0.xzyw + s0.xzyw*sh.xxyy;
  vec4 a1 = b1.xzyw + s1.xzyw*sh.zzww;
  vec3 p0 = vec3(a0.xy, h.x);
  vec3 p1 = vec3(a0.zw, h.y);
  vec3 p2 = vec3(a1.xy, h.z);
  vec3 p3 = vec3(a1.zw, h.w);
  vec4 nrm = taylorInvSqrt(vec4(dot(p0,p0), dot(p1,p1), dot(p2,p2), dot(p3,p3)));
  p0 *= nrm.x; p1 *= nrm.y; p2 *= nrm.z; p3 *= nrm.w;
  vec4 m = max(0.6 - vec4(dot(x0,x0), dot(x1,x1), dot(x2,x2), dot(x3,x3)), 0.0);
  m = m*m;
  return 42.0 * dot(m*m, vec4(dot(p0,x0), dot(p1,x1), dot(p2,x2), dot(p3,x3)));
}`;

const HASH = `
vec3 hash31(float p){
  vec3 q = fract(vec3(p) * vec3(0.1031, 0.1030, 0.0973));
  q += dot(q, q.yxz + 33.33);
  return fract((q.xxy + q.yzz) * q.zyx);
}
float hash21(vec2 p){
  vec3 q = fract(vec3(p.xyx) * 0.1031);
  q += dot(q, q.yzx + 33.33);
  return fract((q.x + q.y) * q.z);
}`;

/* ------------------------------------------------------------------ *
 * Simulation. One texel per particle; MRT writes position + velocity.
 * Every formation is a *target field* and the particles spring toward
 * it - so a mode change is a physical migration, never a cut.
 * ------------------------------------------------------------------ */
export const SIM_FS = `#version 300 es
precision highp float;

#define M_IDLE       0
#define M_FOCUS      1
#define M_AUTH       2
#define M_ALIGN      3
#define M_WARP       4
#define M_AMBIENT    5
#define M_HALT       6
#define M_DUST       7
#define M_REASSEMBLE 8

#define TAU 6.28318530718
#define SHARD_CUT 0.93

uniform sampler2D uPos;
uniform sampler2D uVel;
uniform vec2  uField;        // simulation texture size
uniform float uTime;
uniform float uDt;
uniform int   uMode;
uniform float uStiff;
uniform float uDamp;
uniform float uNoiseAmp;
uniform float uOrbit;        // 0..1 how much of the field orbits the panel
uniform float uEnergy;       // 0..1 password "weight"
uniform float uAlign;        // 0..1 gyroscope ring convergence
uniform float uGyroT;        // gyroscope rotation phase (JS-driven, freezable)
uniform float uGyroPull;     // 0..1 inward collapse of the gyroscope
uniform float uWarp;         // 0..1 warp-drive intensity
uniform float uShatter;      // one-shot outward impulse on the panel shards
uniform vec3  uGyroC;
uniform vec3  uPanelC, uPanelR, uPanelU, uPanelN;   // R and U carry half-extents
uniform vec3  uCamPos, uCamFwd, uCamRight, uCamUp;
uniform vec3  uMouseP;
uniform float uMouseAmt;
uniform float uMousePol;     // +1 attract, -1 repel
uniform vec4  uWaves[8];     // xyz = origin, w = start time (<0 inactive)
uniform float uSpreadK;      // 2*tan(fov/2)*aspect - frustum width per unit depth
uniform float uSnapRate;     // >0: lock onto the target instead of springing
uniform float uWaveAmp[8];

layout(location = 0) out vec4 outPos;
layout(location = 1) out vec4 outVel;

${NOISE}
${HASH}

vec3 turbulence(vec3 p, float t){
  return vec3(
    snoise(p * 0.16 + vec3(0.0, t * 0.12, 0.0)),
    snoise(p * 0.16 + vec3(31.7, t * 0.12, 11.3)),
    snoise(p * 0.16 + vec3(7.1, t * 0.12, 53.9))
  );
}

// The idle ocean. The grid is laid out in *view* depth, not uniform world
// spacing: rows bunch up near the camera and stretch toward the horizon, and
// the field widens with distance so it fills the frustum instead of tapering
// to a visible point. Everything stays in front of the camera.
vec3 topoTarget(vec2 uv, vec3 h, float t, float lift){
  // Hyperbolic in depth, which is what puts rows at even *screen* spacing:
  // uniform world spacing wastes almost everything on the horizon.
  float d = 7.2 / (1.0 - uv.y * 0.92);            // 7.2 .. 90 in front
  float z = uCamPos.z - d;
  float spread = (2.5 + d * 0.97) * uSpreadK;     // exactly fills the frustum
  float x = (uv.x - 0.5) * spread;

  float n1 = snoise(vec3(x * 0.055, z * 0.055, t * 0.050));
  float n2 = snoise(vec3(x * 0.140, z * 0.140, t * 0.085));
  float n3 = snoise(vec3(x * 0.330, z * 0.330, t * 0.140));

  float y = -3.35;
  y += n1 * 2.40;
  y += (1.0 - abs(n2)) * 0.90 - 0.42;             // ridged crests
  y += n3 * 0.22;
  y += lift * (0.55 + 0.9 * h.z);
  return vec3(x, y, z);
}

// A loose shell of particles wheeling around the glass panel. Radius and
// angle come from h2 because h.z is what *selects* the orbiters - deriving
// both from the same hash collapses every one of them onto a single shell.
vec3 orbitTarget(vec3 h, vec3 h2, float t, vec3 C, vec3 R, vec3 U, vec3 N){
  float ang = h2.x * TAU + t * (0.28 + h2.y * 0.55);
  float rad = 1.06 + h2.z * 0.60;
  vec3 rn = normalize(R), un = normalize(U);
  float bob = sin(t * 0.85 + h2.x * TAU) * 0.35;
  return C
       + rn * (cos(ang) * rad * length(R))
       + un * (sin(ang) * rad * length(U))
       + N  * (bob + (h.x - 0.5) * 3.0);
}

// The panel silhouette: a squircle, half perimeter, half interior fill.
vec3 panelTarget(vec3 h, vec3 h2, vec3 C, vec3 R, vec3 U, vec3 N){
  float a = h.x * TAU;
  float ca = cos(a), sa = sin(a);
  float n = 6.0;
  vec2 sq = vec2(sign(ca) * pow(abs(ca), 2.0 / n), sign(sa) * pow(abs(sa), 2.0 / n));
  float r = (h.y < 0.46) ? (0.955 + h.z * 0.045) : sqrt(h.z) * 0.90;
  vec2 c = sq * r;
  // Sit just behind the glass so the CSS backdrop blur frosts them.
  return C + R * c.x + U * c.y + N * (0.12 + h2.x * 0.34);
}

// Interlocking rings, a dense core and radial spokes: the quantum astrolabe.
vec3 gyroTarget(vec3 h, vec3 h2, float gt, float align, vec3 C, vec3 F, vec3 Rt, vec3 Up, float pull){
  if (h.x < 0.09){                                  // core
    float th = h2.x * TAU, ph = acos(2.0 * h2.y - 1.0);
    float rr = 0.34 * pow(h2.z, 0.5);
    vec3 p = C + Rt * (rr * sin(ph) * cos(th)) + Up * (rr * sin(ph) * sin(th)) + F * (rr * cos(ph));
    return mix(p, C, pull * 0.5);
  }
  float fr = floor(h.y * 7.0);
  float R0 = 0.78 + fr * 0.30;
  float dir = (mod(fr, 2.0) < 0.5) ? 1.0 : -1.0;
  float ang = h.z * TAU + gt * (0.95 + fr * 0.44) * dir;
  float teeth = 1.0 + 0.05 * cos(ang * (8.0 + fr * 3.0));       // gear bite
  float rad = R0 * teeth + (h2.x - 0.5) * 0.04;
  // Each ring lives in its own tilted plane; align -> 1 folds them onto one axis.
  float tA = mix(0.35 + fr * 0.62, 0.0, align);
  float tB = mix(fr * 1.15 + gt * 0.05 * mod(fr, 3.0), 0.0, align);
  vec3 a1 =  Rt * cos(tB) + Up * sin(tB);
  vec3 a2 = -Rt * sin(tB) + Up * cos(tB);
  vec3 b2 =  a2 * cos(tA) + F * sin(tA);
  vec3 p = C + a1 * (cos(ang) * rad) + b2 * (sin(ang) * rad);
  if (h.x > 0.90) p = mix(C, p, pow(h2.y, 0.7));                // spokes
  return mix(p, C, pull * 0.55);
}

void main(){
  ivec2 ij = ivec2(gl_FragCoord.xy);
  vec4 P = texelFetch(uPos, ij, 0);
  vec4 V = texelFetch(uVel, ij, 0);
  vec3 pos = P.xyz;
  float seed = P.w;
  vec3 vel = V.xyz;
  float en = V.w;

  float id = float(ij.x) + float(ij.y) * uField.x;
  vec3 h  = hash31(id * 0.7919 + 3.17);
  vec3 h2 = hash31(id * 1.3733 + 11.73);
  // Stratified, not gridded: each particle owns a cell but sits at a random
  // point inside it. A regular lattice reads as wireframe lines in perspective.
  vec2 uv = (vec2(ij) + vec2(h2.y, h2.z)) / uField;

  bool shard = seed > SHARD_CUT;                  // ~7% belong to the panel
  float dt = min(uDt, 0.033);
  float stiff = uStiff;
  float damp  = uDamp;

  vec3 target = pos;
  bool free = false;

  if (uMode == M_IDLE || uMode == M_REASSEMBLE){
    target = shard ? panelTarget(h, h2, uPanelC, uPanelR, uPanelU, uPanelN)
                   : topoTarget(uv, h, uTime, 0.0);
  } else if (uMode == M_FOCUS){
    if (shard){
      target = panelTarget(h, h2, uPanelC, uPanelR, uPanelU, uPanelN);
    } else if (h.z < uOrbit * 0.028){
      target = orbitTarget(h, h2, uTime, uPanelC, uPanelR, uPanelU, uPanelN);
      stiff *= 1.25;
    } else {
      // Everything else lifts a little - the whole ocean leans in.
      target = topoTarget(uv, h, uTime, uOrbit * (0.35 + uEnergy * 0.75));
    }
  } else if (uMode == M_AUTH || uMode == M_ALIGN || uMode == M_HALT){
    target = gyroTarget(h, h2, uGyroT, uAlign, uGyroC, uCamFwd, uCamRight, uCamUp, uGyroPull);
  } else if (uMode == M_AMBIENT){
    target = topoTarget(uv, h, uTime, shard ? 1.6 : 0.0);
  } else {
    free = true;                                   // WARP and DUST are pure forces
  }

  vec3 acc = vec3(0.0);

  if (!free){
    acc += (target - pos) * stiff;
  } else if (uMode == M_WARP){
    float fdist = dot(pos - uCamPos, uCamFwd);
    vec3 lateral = pos - (uCamPos + uCamFwd * fdist);
    acc += -uCamFwd * (150.0 * uWarp);
    acc += normalize(lateral + 1e-4) * (24.0 * uWarp);
    if (fdist < -3.0){                             // recycle behind the camera
      vec3 lat = uCamRight * ((h2.x - 0.5) * 20.0) + uCamUp * ((h2.y - 0.5) * 13.0);
      pos = uCamPos + uCamFwd * (26.0 + h2.z * 24.0) + lat;
      vel = -uCamFwd * 22.0;
    }
  } else {                                         // M_DUST
    acc += vec3(0.0, -8.5, 0.0);
    acc += turbulence(pos, uTime) * 5.5;
  }

  // Ambient drift keeps the field alive even when it is holding a shape.
  acc += turbulence(pos + vec3(0.0, uTime * 0.05, 0.0), uTime) * uNoiseAmp;

  // Cursor magnet: radial pull plus a tangential swirl for a fluid wake.
  if (uMouseAmt > 0.001){
    vec3 d = uMouseP - pos;
    float d2 = dot(d, d);
    float infl = uMouseAmt * exp(-d2 * 0.055);
    vec3 dn = d * inversesqrt(d2 + 1e-4);
    acc += dn * (infl * 30.0 * uMousePol);
    acc += cross(dn, vec3(0.0, 1.0, 0.0)) * (infl * 15.0);
    en = max(en, infl * 0.85);
  }

  // Keystroke shockwaves: an expanding gaussian shell, decaying with age.
  for (int i = 0; i < 8; i++){
    float t0 = uWaves[i].w;
    if (t0 < 0.0) continue;
    float age = uTime - t0;
    if (age < 0.0 || age > 2.0) continue;
    vec3 wd = pos - uWaves[i].xyz;
    float r = length(wd) + 1e-4;
    float front = age * 13.0;
    // Square by multiplying: pow() with a negative base is undefined in GLSL,
    // and (r - front) goes negative as soon as the front passes the particle.
    float w = (r - front) * 2.1;
    float g = exp(-w * w) * exp(-age * 1.7);
    acc += (wd / r) * (g * uWaveAmp[i] * 30.0);
    en = max(en, g * uWaveAmp[i] * 0.95);
  }

  // The glass panel breaking apart.
  if (uShatter > 0.0 && shard){
    vec3 d = pos - uPanelC;
    acc += normalize(d + vec3(0.001)) * (uShatter * 190.0);
    acc += -uCamFwd * (uShatter * 40.0);
    en = max(en, uShatter);
  }

  vel += acc * dt;
  vel *= exp(-damp * dt);                          // frame-rate independent drag
  float sp = length(vel);
  if (sp > 42.0) vel *= 42.0 / sp;                 // keep the integrator sane
  pos += vel * dt;

  // A spring is a low-pass filter. The gyroscope rings turn far faster than
  // any stable spring can follow, so a pure spring parks every particle at the
  // time-average of its target - the centre. For those formations we lock on
  // to the target directly instead, and derive velocity from the step so the
  // energy and trail terms still see the real motion.
  if (uSnapRate > 0.0 && !free){
    float k = 1.0 - exp(-uSnapRate * dt);
    vec3 want = mix(pos, target, k);
    vel = clamp((want - pos) / max(dt, 1e-4), vec3(-60.0), vec3(60.0));
    pos = want;
  }

  en = max(en * exp(-dt * 1.9), clamp(sp * 0.055, 0.0, 1.0));
  en = clamp(max(en, uEnergy * 0.22), 0.0, 1.6);

  // NaN/inf would persist for the lifetime of the page, so recycle instead.
  // Tested on the bit pattern: float comparisons get folded by the optimiser
  // under a no-NaNs assumption, so x != x and !(x < k) are not reliable here.
  uvec3 bits = floatBitsToUint(abs(pos));
  if (any(greaterThanEqual(bits, uvec3(0x7F800000u)))){
    pos = uCamPos + uCamFwd * (14.0 + h2.z * 45.0)
        + uCamRight * ((h.x - 0.5) * 34.0) + uCamUp * ((h.y - 0.5) * 18.0);
    vel = vec3(0.0);
    en = 0.0;
  }

  outPos = vec4(pos, seed);
  outVel = vec4(vel, en);
}`;

/* ------------------------------------------------------------------ *
 * Particle rendering: one GL_POINT per texel, additively blended.
 * ------------------------------------------------------------------ */
export const POINT_VS = `#version 300 es
precision highp float;

uniform sampler2D uPos;
uniform sampler2D uVel;
uniform mat4  uViewProj;
uniform int   uSize;
uniform vec3  uCamPos;
uniform vec3  uColLo;
uniform vec3  uColHi;
uniform float uPointScale;
uniform float uBrightness;
uniform float uShardBoost;
uniform float uCrest;         // 1 while the field is terrain: light the ridges
uniform float uTime;

#define SHARD_CUT 0.93

out vec3  vColor;
out float vFade;

${HASH}

void main(){
  ivec2 ij = ivec2(gl_VertexID % uSize, gl_VertexID / uSize);
  vec4 P = texelFetch(uPos, ij, 0);
  vec4 V = texelFetch(uVel, ij, 0);

  vec3 p = P.xyz;
  gl_Position = uViewProj * vec4(p, 1.0);

  float dist = max(length(p - uCamPos), 0.35);
  vec3  h = hash31(float(gl_VertexID) * 0.517 + 1.7);

  float en = clamp(V.w, 0.0, 1.5);
  float twinkle = 0.72 + 0.28 * sin(uTime * (1.1 + h.y * 2.6) + h.x * 40.0);
  bool  shard = P.w > SHARD_CUT;

  float sz = (uPointScale / dist) * (0.55 + 0.85 * h.z) * (1.0 + en * 0.9);
  if (shard) sz *= 1.15;
  // Below a pixel, fade instead of shrinking - shrinking makes the horizon
  // shimmer because point sprites have no coverage antialiasing.
  float sub = clamp(sz, 0.0, 1.0);
  gl_PointSize = clamp(sz, 1.0, 15.0);

  // Distance attenuation gives the field depth without a depth buffer.
  float atten = clamp(30.0 / (dist * dist * 0.22 + 6.0), 0.015, 1.0);

  // Ridge lighting: crests read brighter than troughs, which is what turns a
  // cloud of points into legible topography. Must stay positive - this is an
  // additive pass, so a negative factor would subtract light from the scene.
  float crest = clamp((p.y + 4.9) * 0.30, 0.0, 1.0);
  float relief = mix(1.0, 0.30 + crest * 1.30, uCrest);

  vec3 col = mix(uColLo, uColHi, clamp(en * 0.85 + h.x * 0.22 + crest * 0.30 * uCrest, 0.0, 1.0));
  vColor = col * uBrightness * twinkle * (0.45 + en * 1.35) * relief * (shard ? uShardBoost : 1.0);
  vFade  = atten * (0.35 + 0.75 * h.y) * sub * sub;
}`;

export const POINT_FS = `#version 300 es
precision highp float;
in  vec3  vColor;
in  float vFade;
out vec4  oColor;
void main(){
  vec2 d = gl_PointCoord - 0.5;
  float r2 = dot(d, d) * 4.0;
  if (r2 > 1.0) discard;
  float a = exp(-r2 * 3.6) * (1.0 - r2 * r2);      // soft bioluminescent core
  oColor = vec4(vColor * a * vFade, 1.0);
}`;

/* ---- Trail feedback: last frame, faded, redrawn underneath ---- */
export const FEEDBACK_FS = `#version 300 es
precision highp float;
in  vec2 vUv;
uniform sampler2D uPrev;
uniform float uDecay;
uniform vec2  uZoom;          // slight inward drift so trails taper
out vec4 oColor;
void main(){
  vec2 uv = (vUv - 0.5) * uZoom + 0.5;
  oColor = texture(uPrev, uv) * uDecay;
}`;

/* ---- Bloom: soft-knee bright pass, then a separable gaussian chain ---- */
export const BRIGHT_FS = `#version 300 es
precision highp float;
in  vec2 vUv;
uniform sampler2D uSrc;
uniform float uThreshold;
uniform float uKnee;
out vec4 oColor;
void main(){
  vec3 c = texture(uSrc, vUv).rgb;
  float l = max(c.r, max(c.g, c.b));
  float soft = clamp(l - uThreshold + uKnee, 0.0, 2.0 * uKnee);
  soft = soft * soft / (4.0 * uKnee + 1e-4);
  float w = max(soft, l - uThreshold) / max(l, 1e-4);
  oColor = vec4(c * w, 1.0);
}`;

export const BLUR_FS = `#version 300 es
precision highp float;
in  vec2 vUv;
uniform sampler2D uSrc;
uniform vec2 uDir;            // texel-sized step along one axis
out vec4 oColor;
void main(){
  // 9-tap gaussian folded into 5 bilinear fetches.
  vec3 sum = texture(uSrc, vUv).rgb * 0.2270270270;
  sum += texture(uSrc, vUv + uDir * 1.3846153846).rgb * 0.3162162162;
  sum += texture(uSrc, vUv - uDir * 1.3846153846).rgb * 0.3162162162;
  sum += texture(uSrc, vUv + uDir * 3.2307692308).rgb * 0.0702702703;
  sum += texture(uSrc, vUv - uDir * 3.2307692308).rgb * 0.0702702703;
  oColor = vec4(sum, 1.0);
}`;

/* ---- Composite: bloom, chromatic aberration, glitch, tonemap, grain ---- */
export const COMPOSITE_FS = `#version 300 es
precision highp float;
in  vec2 vUv;

uniform sampler2D uScene;
uniform sampler2D uBloom0;
uniform sampler2D uBloom1;
uniform sampler2D uBloom2;
uniform float uBloomAmt;
uniform float uExposure;
uniform float uCA;            // baseline chromatic aberration
uniform float uGlitch;        // 0..1 failure glitch
uniform float uFlash;         // 0..1 volumetric bloom flash
uniform vec3  uFlashCol;
uniform vec3  uAmbient;       // deep background wash
uniform float uTime;
uniform float uVignette;
uniform float uGrain;

out vec4 oColor;

${HASH}

vec3 aces(vec3 x){
  const float a = 2.51, b = 0.03, c = 2.43, d = 0.59, e = 0.14;
  return clamp((x * (a * x + b)) / (x * (c * x + d) + e), 0.0, 1.0);
}

vec3 sampleBloom(vec2 uv){
  return texture(uBloom0, uv).rgb * 0.52
       + texture(uBloom1, uv).rgb * 0.32
       + texture(uBloom2, uv).rgb * 0.22;
}

void main(){
  vec2 uv = vUv;
  vec2 fromCenter = uv - 0.5;
  float r = length(fromCenter);

  // Horizontal block tearing while the structure jams.
  if (uGlitch > 0.001){
    float band = floor(uv.y * 34.0);
    float n = hash21(vec2(band, floor(uTime * 18.0)));
    float on = step(0.72 - uGlitch * 0.35, n);
    uv.x += (n - 0.5) * 0.16 * uGlitch * on;
    uv.y += (hash21(vec2(band * 3.1, floor(uTime * 11.0))) - 0.5) * 0.012 * uGlitch * on;
    uv = clamp(uv, 0.0, 1.0);
  }

  // Chromatic aberration: baseline lens error, violently amplified on failure.
  float ca = uCA + uGlitch * 0.035;
  vec2 off = fromCenter * ca * (0.35 + r * 1.8);
  vec3 scene;
  scene.r = texture(uScene, uv + off).r;
  scene.g = texture(uScene, uv).g;
  scene.b = texture(uScene, uv - off).b;

  vec3 bloom;
  bloom.r = sampleBloom(uv + off * 1.6).r;
  bloom.g = sampleBloom(uv).g;
  bloom.b = sampleBloom(uv - off * 1.6).b;

  vec3 col = scene + bloom * uBloomAmt;

  // Deep-field wash so the void is never flatly black.
  col += uAmbient * (1.0 - smoothstep(0.0, 0.95, r));

  // The resolution flash.
  col += uFlashCol * uFlash * (1.2 - r * 0.55);

  col = aces(col * uExposure);

  col *= mix(1.0, 1.0 - r * r * 1.35, uVignette);

  float g = hash21(uv * vec2(1024.0, 768.0) + fract(uTime) * 91.7) - 0.5;
  col += g * uGrain * (1.0 - 0.6 * dot(col, vec3(0.333)));

  oColor = vec4(max(col, 0.0), 1.0);
}`;
