// The sign-in form, and the choreography it drives.
//
// Phase 1: focusing a field holds the sale, typing an address assembles the
// badge, and a password arms the counter.
//
// Step 6 adds the round trip. Submitting moves the stage to authorising and
// hands the outcome back to it: approved, declined, or locked. The visual
// choreography of each of those - the badge hand-off, the drawer, the printed
// receipt, the supervisor screen - arrives in steps 7 to 10. What is here is
// the honest skeleton: a real request, a real pause, a real result.

import { Badge } from './badge.js';
import { login, probe, state as authState } from './auth.js';
import { runHandoff } from './handoff.js';
import { runApproved, runSignOut } from './approved.js';
import { Printer, declinedReceipt, lockedReceipt, signOnReceipt } from './printer.js';

const $ = (sel) => document.querySelector(sel);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The states the form is allowed to drive on focus changes. Anything else
// belongs to the auth sequence and must not be stomped on by a blur.
const FORM_STATES = ['idle', 'held', 'entering'];

// The authorising pause is the point of the design, so it has a floor even
// if the service answers instantly.
const AUTH_MIN_MS = 2000;

export function initForm({ stage, lane }) {
  const form = $('#signin-form');
  const email = $('#email');
  const password = $('#password');
  const reveal = $('#reveal');
  const caps = $('#caps');
  const forgot = $('#forgot');
  const recall = $('#fkey-recall');
  const submit = $('#submit');
  const status = $('#signin-status');
  const net = $('#pos-net');
  const badge = new Badge($('.badge'));
  const printer = new Printer();

  const idleStatus = status.textContent;
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  let busy = false;
  let lockTimer = null;

  /* ---- Reachability -------------------------------------------------- *
     While the counter is doing something, the controls are disabled rather
     than the form being made inert: inert would also hide the live region,
     and the status message is how this is announced. */
  const controls = [email, password, reveal, submit, recall].filter(Boolean);
  stage.on((name) => {
    const live = FORM_STATES.includes(name);
    for (const control of controls) control.disabled = !live;
  });

  /* ---- Status ------------------------------------------------------- *
     The status line doubles as the demo hint when it has nothing to say,
     so the panel never changes height when a message arrives. */
  function setStatus(message, kind) {
    if (!message) {
      status.textContent = idleStatus;
      delete status.dataset.kind;
      return;
    }
    status.textContent = message;
    status.dataset.kind = kind || 'info';
  }

  /* ---- Stage ------------------------------------------------------- */
  function sync() {
    if (!stage.is(...FORM_STATES)) return;
    if (!form.contains(document.activeElement)) { stage.set('idle'); return; }
    stage.set(password.value ? 'entering' : 'held');
  }

  form.addEventListener('focusin', sync);
  // focusout fires before focus lands on the next element, so let it settle.
  form.addEventListener('focusout', () => setTimeout(sync, 0));

  /* ---- Badge assembly ---------------------------------------------- */
  // Changing the account tears the drift off - a different name on the badge
  // is a fresh start. Retyping the password is not: that is the same run of
  // failures continuing, and the drift growing is the whole point of it. If
  // any keystroke tore the stack off it could never reach two, because a
  // decline clears the password and the retry has to be typed.
  const clearPaper = () => { if (printer.hasPaper) printer.tearOff(); };

  email.addEventListener('input', () => {
    badge.setAccount(email.value);
    if (status.dataset.kind) setStatus('');
    clearPaper();
  });
  password.addEventListener('input', () => {
    badge.setCharged(password.value.length > 0);
    if (status.dataset.kind) setStatus('');
    sync();
  });

  // Autofill does not always fire input events the way typing does.
  window.addEventListener('pageshow', () => {
    if (email.value) badge.setAccount(email.value);
    if (password.value) badge.setCharged(true);
  });

  /* ---- Reveal ------------------------------------------------------- */
  reveal.addEventListener('click', () => {
    const show = password.type === 'password';
    password.type = show ? 'text' : 'password';
    reveal.setAttribute('aria-pressed', String(show));
    reveal.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
    // Keep the caret where the user left it rather than jumping to the end.
    const { selectionStart, selectionEnd } = password;
    password.focus();
    try { password.setSelectionRange(selectionStart, selectionEnd); }
    catch { /* not supported on every input type */ }
  });

  /* ---- Caps Lock ---------------------------------------------------- *
     Checked on both fields: a capitalised address is harmless, but people
     often notice the warning there first and fix it before the password. */
  function checkCaps(event) {
    const on = typeof event.getModifierState === 'function'
      && event.getModifierState('CapsLock');
    caps.hidden = !on;
  }
  for (const el of [email, password]) {
    el.addEventListener('keydown', checkCaps);
    el.addEventListener('keyup', checkCaps);
    el.addEventListener('focus', checkCaps);
  }
  password.addEventListener('blur', () => { caps.hidden = true; });

  /* ---- F1 Recall ----------------------------------------------------- *
     The only function key that does anything yet, so the only one rendered
     as a button. It moves focus to password recovery, which is what Recall
     means on a till: bring back what was set aside. */
  const recallPassword = () => forgot.focus();
  recall.addEventListener('click', recallPassword);
  window.addEventListener('keydown', (event) => {
    if (event.key !== 'F1') return;
    event.preventDefault();
    recallPassword();
  });

  /* ---- Lockout ------------------------------------------------------- *
     Counts down in the status line. Step 10 gives this its own full-bleed
     supervisor screen; the till is genuinely refusing input either way. */
  function lockdown(seconds) {
    let left = Math.max(1, Number(seconds) || 30);
    clearTimeout(lockTimer);

    const tick = () => {
      if (left <= 0) {
        setStatus('');
        busy = false;
        submit.disabled = false;
        stage.set('idle');
        sync();
        return;
      }
      setStatus(`Terminal locked. A supervisor must unlock this till. ${left}s`, 'error');
      left -= 1;
      lockTimer = setTimeout(tick, 1000);
    };
    tick();
  }

  /* ---- Submit -------------------------------------------------------- */
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (busy) return;

    const address = email.value.trim();
    if (!address || !password.value) {
      setStatus('Enter your email and password.', 'warn');
      (address ? password : email).focus();
      return;
    }
    if (!email.checkValidity()) {
      setStatus('That email address does not look right.', 'warn');
      email.focus();
      return;
    }

    busy = true;
    submit.disabled = true;
    stage.set('authorising');
    setStatus('Authorising. Do not remove card.', 'info');

    const started = performance.now();

    // The request and the hand-off run together, and both must finish. The
    // badge must never still be in the air when the outcome lands.
    const [result] = await Promise.all([
      login(address, password.value),
      runHandoff({
        badgeEl: $('.badge'),
        scannerEl: $('.scanner'),
        glassEl: $('.scanner__glass'),
        readerEl: $('.reader'),
        slotEl: $('.reader__slot'),
        reduced,
      }),
    ]);

    const remaining = AUTH_MIN_MS - (performance.now() - started);
    if (remaining > 0) await sleep(remaining);

    if (result.ok) {
      stage.set('approved');
      setStatus(`Signed in as ${result.user.name}. ${result.user.role}.`, 'ok');
      await runApproved({ user: result.user, lane, reduced });
      // The drift of failures drops away and a single SIGNED ON takes its place.
      printer.tearOff();
      printer.print(signOnReceipt(result.user), { reduced });
      // Signed on. Nothing to submit again until they sign out.
      return;
    }

    if (result.code === 'locked') {
      stage.set('locked');
      shudder();
      printer.print(lockedReceipt({ account: address, seconds: result.retryAfter || 30 }), { reduced });
      lockdown(result.retryAfter);
      return;
    }

    stage.set('declined');
    const count = result.attempt && result.of
      ? ` Attempt ${result.attempt} of ${result.of}.`
      : '';
    setStatus(result.message + count, 'error');
    shudder();
    await printer.print(
      declinedReceipt({ account: address, attempt: result.attempt, of: result.of }),
      { reduced },
    );

    // The password is cleared but the address is kept - nobody should have to
    // retype an email because they fat-fingered a symbol.
    await sleep(700);
    password.value = '';
    badge.setCharged(false);
    busy = false;
    submit.disabled = false;
    stage.set('idle');
    sync();
    password.focus();
  });

  /* ---- The screen takes the impact ------------------------------------ */
  function shudder() {
    if (reduced) return;
    const pos = $('.pos');
    pos?.classList.remove('is-shuddering');
    void pos?.offsetWidth;
    pos?.classList.add('is-shuddering');
    setTimeout(() => pos?.classList.remove('is-shuddering'), 560);
  }

  /* ---- Sign out ------------------------------------------------------- *
     The one real control the app shell carries, and the only way back to
     the login without a reload. */
  $('#signout')?.addEventListener('click', () => {
    runSignOut({ badge });
    printer.tearOff();
    password.value = '';
    email.value = '';
    setStatus('');
    busy = false;
    submit.disabled = false;
    stage.set('idle');
    setTimeout(() => email.focus(), 320);
  });

  /* ---- Link state ---------------------------------------------------- */
  probe().then((online) => {
    if (net) net.textContent = online ? 'Online' : 'Offline';
    if (!online) net.dataset.offline = '';
    if (authState.offline) {
      console.info('[auth] service unreachable - using the offline stand-in');
    }
  });

  return { badge, sync, setStatus };
}
