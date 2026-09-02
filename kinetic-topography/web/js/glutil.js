// Thin WebGL2 conveniences: programs, float render targets, fullscreen passes.

export function compile(gl, type, src, label) {
  const sh = gl.createShader(type);
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(sh) || '';
    // Point at the offending line - shader debugging without this is misery.
    const numbered = src.split('\n').map((l, i) => String(i + 1).padStart(4) + ' | ' + l).join('\n');
    console.error(`[${label}] shader compile failed\n${log}\n${numbered}`);
    throw new Error(`${label}: ${log}`);
  }
  return sh;
}

export function program(gl, vsSrc, fsSrc, label = 'program') {
  const p = gl.createProgram();
  gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, vsSrc, label + ':vs'));
  gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, fsSrc, label + ':fs'));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
    throw new Error(`${label}: ${gl.getProgramInfoLog(p)}`);
  }
  // Cache uniform locations up front; `u.foo` is then a plain property read.
  const u = {};
  const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
  for (let i = 0; i < n; i++) {
    const info = gl.getActiveUniform(p, i);
    const name = info.name.replace(/\[0\]$/, '');
    u[name] = gl.getUniformLocation(p, name);
  }
  return { p, u, use: () => gl.useProgram(p) };
}

export function texture(gl, w, h, internalFormat, format, type, data = null, filter = gl.NEAREST) {
  const t = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, t);
  gl.texImage2D(gl.TEXTURE_2D, 0, internalFormat, w, h, 0, format, type, data);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.bindTexture(gl.TEXTURE_2D, null);
  return t;
}

/** Framebuffer over one or more colour attachments. */
export function framebuffer(gl, textures) {
  const fb = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
  const bufs = [];
  textures.forEach((t, i) => {
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0 + i, gl.TEXTURE_2D, t, 0);
    bufs.push(gl.COLOR_ATTACHMENT0 + i);
  });
  gl.drawBuffers(bufs);
  const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
  if (status !== gl.FRAMEBUFFER_COMPLETE) throw new Error('incomplete framebuffer: 0x' + status.toString(16));
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  return fb;
}

/** An HDR colour target plus its framebuffer, sized in device pixels. */
export function renderTarget(gl, w, h, filter = gl.LINEAR) {
  const tex = texture(gl, w, h, gl.RGBA16F, gl.RGBA, gl.HALF_FLOAT, null, filter);
  return { tex, fb: framebuffer(gl, [tex]), w, h };
}

export function bindRT(gl, rt) {
  gl.bindFramebuffer(gl.FRAMEBUFFER, rt ? rt.fb : null);
  if (rt) gl.viewport(0, 0, rt.w, rt.h);
}

export function bindTex(gl, unit, tex, loc) {
  gl.activeTexture(gl.TEXTURE0 + unit);
  gl.bindTexture(gl.TEXTURE_2D, tex);
  if (loc) gl.uniform1i(loc, unit);
}

/** Vertex shader for every fullscreen pass: one oversized triangle, no buffers. */
export const FULLSCREEN_VS = `#version 300 es
out vec2 vUv;
void main(){
  vec2 p = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
  vUv = p;
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;
