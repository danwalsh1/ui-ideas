// Choreography. The field is a dumb physics box; this file is the director.

import { KineticField, QUALITY } from './field.js';
import { Sound } from './audio.js';
import * as Auth from './auth.js';

const $ = (sel, root = document) => root.querySelector(sel);

const canvas = $('#gl');
const panel = $('#panel');
const form = $('#login-form');
const userInput = $('#username');
const passInput = $('#password');
const submitBtn = $('#submit');
const statusEl = $('#status');
const dash = $('#dashboard');
const hud = $('#hud');
const capsHint = $('#caps');
const revealBtn = $('#reveal');
const meterEl = $('#meter');

const MIN_AUTH_MS = 2300;   // the gyroscope needs room to build tension
const sound = new Sound();

let field = null;
let busy = false;
let reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
let soundOn = false;

/* ------------------------------------------------------------------ *
 * Tiny tween runner, driven by the same rAF as the field.
 * ------------------------------------------------------------------ */
const tweens = new Set();
const easeOutCubic = (t) => 1 - Math.pow(1 - t, 3);
const easeInOutCubic = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const easeOutBack = (t) => 1 + 2.2 * Math.pow(t - 1, 3) + 1.4 * Math.pow(t - 1, 2);

function tween(ms, fn, ease = easeInOutCubic) {
  return new Promise((resolve) => tweens.add({ t: 0, ms, fn, ease, resolve }));
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------------ *
 * Boot
 * ------------------------------------------------------------------ */
function pickQuality() {
  const saved = localStorage.getItem('kt-quality');
  if (saved && QUALITY[saved]) return saved;
  const cores = navigator.hardwareConcurrency || 4;
  const wide = window.screen.width * (window.devicePixelRatio || 1);
  if (cores <= 4 || wide < 1400) return 'medium';
  return 'high';
}

function boot() {
  try {
    field = new KineticField(canvas, { quality: pickQuality() });
  } catch (err) {
    console.warn('Kinetic field unavailable:', err.message);
    document.body.classList.add('no-gl');
    startUI();
    return;
  }

  field.setPanelElement(panel);
  window.kineticField = field;                    // handle for tuning / debugging
  document.body.classList.add('gl-ready');
  startUI();

  let last = performance.now();
  let acc = 0, frames = 0;

  const loop = (now) => {
    const dt = Math.min((now - last) / 1000, 0.1);
    last = now;

    for (const o of [...tweens]) {
      o.t += dt * 1000;
      const p = Math.min(1, o.t / o.ms);
      o.fn(o.ease(p), p);
      if (p >= 1) { tweens.delete(o); o.resolve(); }
    }

    field.frame(dt);

    // Adaptive resolution: if we are consistently missing frames, render
    // fewer pixels before we start throwing away particles.
    acc += dt; frames++;
    if (acc > 1.5) {
      const fps = frames / acc;
      if (fps < 40 && field.renderScale > 0.62) {
        field.renderScale = Math.max(0.62, field.renderScale - 0.12);
        field._resize(true);
      } else if (fps > 57 && field.renderScale < 1) {
        field.renderScale = Math.min(1, field.renderScale + 0.06);
        field._resize(true);
      }
      acc = 0; frames = 0;
    }
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
}

/* ------------------------------------------------------------------ *
 * Idle interaction
 * ------------------------------------------------------------------ */
function wirePointer() {
  if (!field) return;
  window.addEventListener('pointermove', (e) => {
    field.setPointer(e.clientX, e.clientY);
    field.setMouseInfluence(busy ? 0.25 : 0.95);
  }, { passive: true });

  window.addEventListener('pointerleave', () => field.setMouseInfluence(0));
  // Hold to push the field away instead of drawing it in.
  window.addEventListener('pointerdown', () => field.setMousePolarity(-1.4));
  window.addEventListener('pointerup', () => field.setMousePolarity(1));

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) sound.humStop(0.2);
  });
}

function passwordEnergy() {
  // "Weight" is length plus a little credit for character variety.
  const v = passInput.value;
  if (!v) return 0;
  const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((r) => r.test(v)).length;
  return Math.min(1, (v.length / 16) * 0.8 + (classes / 4) * 0.25);
}

function wireForm() {
  const focusIn = () => {
    if (busy) return;
    // The orbit target only has meaning in focus mode - both must change.
    field?.setMode('focus');
    field?.setOrbit(passInput === document.activeElement ? 0.9 : 0.6);
    panel.classList.add('is-focused');
  };
  const focusOut = () => {
    setTimeout(() => {
      if (busy) return;
      if (panel.contains(document.activeElement)) return;
      field?.setOrbit(0);
      field?.setMode('idle');
      panel.classList.remove('is-focused');
    }, 0);
  };

  for (const el of [userInput, passInput]) {
    el.addEventListener('focus', focusIn);
    el.addEventListener('blur', focusOut);
  }

  userInput.addEventListener('input', () => {
    field?.pulseAtElement(userInput, 0.22);
    sound.key(0.08, false);
    clearStatus();
  });

  passInput.addEventListener('input', () => {
    const e = passwordEnergy();
    field?.setEnergy(e);
    field?.blendPalette('calm', 'kinetic', e);
    // Each character detonates a shockwave through the grid.
    field?.pulseAtElement(passInput, 0.4 + e * 0.55);
    sound.setEnergy(e);
    sound.key(e, true);
    meterEl.style.setProperty('--fill', `${Math.round(e * 100)}%`);
    panel.style.setProperty('--charge', e.toFixed(3));
    clearStatus();
  });

  // Caps Lock is the classic silent login failure; surface it.
  const caps = (e) => {
    const on = e.getModifierState && e.getModifierState('CapsLock');
    capsHint.hidden = !on;
  };
  passInput.addEventListener('keydown', caps);
  passInput.addEventListener('keyup', caps);

  revealBtn.addEventListener('click', () => {
    const show = passInput.type === 'password';
    passInput.type = show ? 'text' : 'password';
    revealBtn.setAttribute('aria-pressed', String(show));
    revealBtn.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
    passInput.focus();
  });

  form.addEventListener('submit', onSubmit);
}

function setStatus(msg, kind = 'info') {
  statusEl.textContent = msg;
  statusEl.dataset.kind = kind;
  statusEl.classList.toggle('is-visible', Boolean(msg));
}
const clearStatus = () => { if (statusEl.textContent) setStatus(''); };

/* ------------------------------------------------------------------ *
 * Phase 2 + 3
 * ------------------------------------------------------------------ */
async function onSubmit(ev) {
  ev.preventDefault();
  if (busy) return;

  if (!userInput.value.trim() || !passInput.value) {
    setStatus('Both fields are required.', 'warn');
    panel.classList.remove('is-shuddering');
    void panel.offsetWidth;                       // restart the animation
    panel.classList.add('is-shuddering');
    field?.pulse(0.7);
    sound.thud();
    (userInput.value.trim() ? passInput : userInput).focus();
    return;
  }

  busy = true;
  submitBtn.disabled = true;
  setStatus('');
  await sound.init().catch(() => {});

  const username = userInput.value.trim();
  const password = passInput.value;
  const started = performance.now();

  collapse();
  const result = await Auth.login(username, password);

  // Never cut the tension short, even on a fast local response.
  const remaining = MIN_AUTH_MS - (performance.now() - started);
  if (remaining > 0) await sleep(remaining);

  if (result.ok) await resolveSuccess(result);
  else await resolveFailure(result);

  busy = false;
  submitBtn.disabled = false;
}

/** The glass panel shatters and the field becomes the engine. */
function collapse() {
  document.body.classList.add('is-authenticating');
  panel.classList.add('is-shattered');
  if (!field) return;

  field.freezePanel(true);
  field.shatterPanel(1);
  field.setMode('auth');
  field.setOrbit(0);
  field.setMouseInfluence(0.2);
  sound.humStart(MIN_AUTH_MS / 1000 + 0.4);

  const dollyTo = reduced ? 0.18 : 0.6;
  field.setDolly(dollyTo);

  // Spin up, pull light inward: the tension curve.
  tween(MIN_AUTH_MS + 400, (t) => {
    field.setGyroSpin(1.1 + t * 5.2);
    field.setGyroPull(t * 0.34);
    field.setExposureBias(1 + t * 0.22);
  }, (t) => t * t);
}

async function resolveSuccess(result) {
  if (!field) { finishSuccess(result); return; }

  // The rings snap onto one axis.
  field.setMode('align');
  field.setAlign(1);
  field.setGyroSpin(11);
  field.setPalette('success');
  // Never await a tween: tweens advance on rAF, which the browser stops in a
  // background tab. Waiting on one would leave the login stuck mid-sequence
  // until the user came back. Timers drive the choreography; the tween only
  // decorates it, and the sequence sets its own final values regardless.
  const alignMs = reduced ? 260 : 420;
  tween(alignMs, (t) => {
    field.setGyroPull(0.34 + t * 0.35);
    field.setDolly((reduced ? 0.18 : 0.6) + t * 0.2);
  }, easeOutCubic);
  await sleep(alignMs);

  // The bloom.
  sound.humStop(0.35);
  sound.success();
  field.flashOut(reduced ? 0.7 : 1.5, [1.0, 0.86, 0.52]);
  document.body.classList.add('is-flashing');
  setTimeout(() => document.body.classList.remove('is-flashing'), 500);

  if (!reduced) {
    field.setMode('warp');
    field.setWarp(1);
    field.setDolly(1);
  }

  // The dashboard is already underneath; the light simply clears off it.
  setTimeout(() => finishSuccess(result), reduced ? 220 : 380);

  await sleep(reduced ? 500 : 1000);

  field.setWarp(0);
  field.setAlign(0);
  field.setGyroSpin(0);
  field.setGyroPull(0);
  field.setDolly(0);
  field.setExposureBias(1);
  field.setMode('ambient');
  field.setPalette('calm');
  field.freezePanel(false);
  field.setMouseInfluence(0.8);
}

function finishSuccess(result) {
  document.body.classList.remove('is-authenticating');
  document.body.classList.add('is-authenticated');
  $('#dash-name').textContent = result.user?.name || 'Operator';
  $('#dash-role').textContent = result.user?.role || 'Systems';
  $('#dash-token').textContent = (result.token || '').slice(0, 18) + '…';
  $('#dash-source').textContent = Auth.state.offline ? 'offline stand-in' : 'kt-auth service';
  $('#dash-density').textContent = field ? field.count.toLocaleString() : 'CSS only';
  dash.hidden = false;
  void dash.offsetWidth;              // flush layout so the transition plays
  dash.classList.add('is-in');
  setTimeout(() => $('#signout').focus(), 900);
}

async function resolveFailure(result) {
  if (!field) {
    setStatus(result.message || 'Access denied.', 'error');
    panel.classList.remove('is-shattered');
    document.body.classList.remove('is-authenticating');
    passInput.select();
    return;
  }

  // The gear jams.
  field.jamGyro();
  field.setMode('halt');
  field.setPalette('failure');
  sound.humStop(0.12);
  sound.failure();
  await sleep(reduced ? 120 : 260);

  // Channel split and digital dust.
  field.setGlitch(1);
  document.body.classList.add('is-glitching');
  field.setMode('dust');
  field.setDolly(0.12);
  field.setExposureBias(1.1);
  tween(900, (t) => field.setGlitch(1 - t), easeOutCubic);
  await sleep(reduced ? 380 : 780);

  // Reverse-assembly.
  document.body.classList.remove('is-glitching');
  field.freezePanel(false);
  field.setMode('reassemble');
  field.setDolly(0);
  field.setExposureBias(1);
  tween(900, (t) => field.blendPalette('failure', 'calm', t), easeInOutCubic);
  await sleep(reduced ? 200 : 420);

  // The panel lands and shudders.
  document.body.classList.remove('is-authenticating');
  panel.classList.remove('is-shattered');
  panel.classList.remove('is-shuddering');
  void panel.offsetWidth;
  panel.classList.add('is-shuddering');
  sound.thud();
  field.pulse(0.9);

  setStatus(result.message || 'Access denied.', 'error');
  await sleep(reduced ? 200 : 560);

  field.setMode('idle');
  field.setGlitch(0);
  field.setPalette('calm');
  field.setEnergy(passwordEnergy());
  field.setMouseInfluence(0.95);
  passInput.focus();
  passInput.select();
}

/* ------------------------------------------------------------------ *
 * Dashboard
 * ------------------------------------------------------------------ */
function wireDashboard() {
  $('#signout').addEventListener('click', async () => {
    dash.classList.remove('is-in');
    field?.setMode('idle');
    field?.setPalette('calm');
    field?.pulse(0.8);
    sound.thud();
    await sleep(520);
    dash.hidden = true;
    document.body.classList.remove('is-authenticated');
    passInput.value = '';
    meterEl.style.setProperty('--fill', '0%');
    panel.style.setProperty('--charge', '0');
    field?.setEnergy(0);
    setStatus('');
    panel.classList.remove('is-shattered');
    requestAnimationFrame(() => userInput.focus());
  });
}

/* ------------------------------------------------------------------ *
 * HUD
 * ------------------------------------------------------------------ */
function wireHud() {
  const soundBtn = $('#toggle-sound');
  const motionBtn = $('#toggle-motion');
  const qualitySel = $('#quality');

  soundBtn.addEventListener('click', async () => {
    soundOn = !soundOn;
    if (soundOn) await sound.init();
    sound.setEnabled(soundOn);
    soundBtn.setAttribute('aria-pressed', String(soundOn));
    soundBtn.querySelector('.hud-value').textContent = soundOn ? 'on' : 'off';
  });

  motionBtn.addEventListener('click', () => {
    reduced = !reduced;
    motionBtn.setAttribute('aria-pressed', String(!reduced));
    motionBtn.querySelector('.hud-value').textContent = reduced ? 'reduced' : 'full';
    document.body.classList.toggle('reduced-motion', reduced);
  });
  motionBtn.querySelector('.hud-value').textContent = reduced ? 'reduced' : 'full';
  document.body.classList.toggle('reduced-motion', reduced);

  qualitySel.value = pickQuality();
  qualitySel.addEventListener('change', () => {
    localStorage.setItem('kt-quality', qualitySel.value);
    field?.setQuality(qualitySel.value);
    if (field) $('#dash-density').textContent = field.count.toLocaleString();
  });
  if (!field) qualitySel.disabled = true;

  // Keep the HUD out of the way until the pointer is near it.
  hud.addEventListener('pointerenter', () => hud.classList.add('is-open'));
  hud.addEventListener('pointerleave', () => hud.classList.remove('is-open'));
}

/* ------------------------------------------------------------------ */
function startUI() {
  wirePointer();
  wireForm();
  wireDashboard();
  wireHud();
  Auth.probe().then((online) => {
    $('#link-state').textContent = online ? 'kt-auth · linked' : 'offline stand-in';
    $('#link-state').classList.toggle('is-offline', !online);
  });
  userInput.focus({ preventScroll: true });

  // The panel arrives once the field has assembled itself out of the dark.
  // This lives here, not in boot(), because the no-WebGL path returns early -
  // and a login panel that never gets `is-in` stays at opacity 0 forever.
  setTimeout(() => panel.classList.add('is-in'), field && !reduced ? 900 : 120);
}

boot();
