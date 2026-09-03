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
  const lockScreen = $('#lockout');
  const lockCount = $('#lockout-count');
  const lockClock = $('#lockout-clock');
  const lockRef = $('#lockout-ref');
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
  stage.on((name, previous) => {
    const live = FORM_STATES.includes(name);
    for (const control of controls) control.disabled = !live;
    // #forgot is an anchor and cannot be disabled. Reaching it under an
    // opaque takeover would be reaching through the screen.
    forgot.tabIndex = live ? 0 : -1;
    // Any way out of locked - the lock expiring, signing out, the debug
    // switcher - cancels the countdown, so it can never fire later and stomp
    // whatever state the counter has moved on to.
    // Any exit from locked that is not release() - the debug switcher, a
    // ?state= jump - has to hand the form back as well as stop the clock.
    // busy is what actually gates submit, so leaving it set behind an
    // enabled-looking button swallows every attempt after it, silently.
    if (previous === 'locked' && name !== 'locked') {
      stopLock();
      busy = false;
      submit.disabled = !live;
    }
    // A debug jump into locked never calls lockdown(), so the digits are
    // reset rather than left showing the tail of a real one.
    if (name === 'locked' && !lockTimer && lockCount) lockCount.textContent = '00:30';
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
  // Gated: under an opaque takeover this would throw focus at a link nobody
  // can see, behind the screen.
  const recallPassword = () => { if (stage.is(...FORM_STATES)) forgot.focus(); };
  recall.addEventListener('click', recallPassword);
  window.addEventListener('keydown', (event) => {
    if (event.key !== 'F1') return;
    event.preventDefault();
    recallPassword();
  });

  /* ---- Lockout ------------------------------------------------------- *
     The screen is the notice; the room is the alarm. This writes the digits,
     the time and the reference, and one announcement at each end of the lock.
     No colour and no class carrying meaning ever enters here - that all lives
     in lockout.css, keyed off [data-state].

     The clock is a deadline, not a decrement. setTimeout drifts, and a hidden
     tab clamps it to about a second - printer.js documents this codebase
     hitting exactly that on the paper feed. Thirty accumulated "about a
     second"s would still be counting long after the service had forgotten the
     lock. */
  const pad = (n) => String(n).padStart(2, '0');
  const mmss = (s) => `${pad(Math.floor(s / 60))}:${pad(s % 60)}`;
  const lockRefFor = (d = new Date()) => `LK-04-${pad(d.getHours())}${pad(d.getMinutes())}`;
  let lockUntil = 0;

  /* The lock's identity, kept beside its deadline. Neither the service nor the
     stand-in records when a lock started or what it was called - only when it
     ends - so a restore after a reload would mint a fresh reference and a
     fresh clock from the time of the reload. The operator would then be
     holding a receipt saying LK-04-1216 while the screen said LK-04-1217:
     two references for one lock, which is the exact disagreement the single
     generated ref exists to prevent. */
  const LOCK_META = 'openlane.lockmeta';

  function rememberLock(ref, clock) {
    try { sessionStorage.setItem(LOCK_META, JSON.stringify({ ref, clock })); }
    catch { /* storage can be denied; the lock still runs, it just cannot be recalled */ }
  }

  function recallLock() {
    try { return JSON.parse(sessionStorage.getItem(LOCK_META)) || null; }
    catch { return null; }
  }

  function paintLock() {
    // Ceil, never floor: the screen must reach 00:00 no earlier than the
    // service does. Rounding up is the direction that keeps the promise.
    const left = Math.max(0, Math.ceil((lockUntil - performance.now()) / 1000));
    if (lockCount) lockCount.textContent = mmss(left);
    return left;
  }

  function stopLock() {
    clearTimeout(lockTimer);
    lockTimer = null;
    lockUntil = 0;
  }

  function lockdown(seconds, { takeFocus = true, ref = lockRefFor(), clock = '' } = {}) {
    const total = Math.max(1, Math.round(Number(seconds) || 30));
    // A second locked answer resets the deadline rather than compounding it.
    stopLock();
    lockUntil = performance.now() + total * 1000;

    const clockText = clock || new Date().toLocaleTimeString('en-GB', { hour12: false });
    if (lockClock) lockClock.textContent = clockText;
    if (lockRef) lockRef.textContent = ref;
    rememberLock(ref, clockText);
    paintLock();

    // One polite announcement, not thirty. The status region is atomic, so a
    // write per second would re-read the whole sentence and leave a queue that
    // never drains.
    setStatus(
      `Terminal locked. A supervisor must unlock this till. Try again in ${total} seconds.`,
      'error',
    );

    // Submit was disabled out from under the pointer, so focus is on nothing.
    // Flush the style change first: the panel is visibility: hidden until the
    // attribute lands and focusing a hidden element is a no-op. Reading a
    // layout property forces that recalculation synchronously. A rAF would do
    // it too, but a hidden tab never delivers one, and a lock can perfectly
    // well land while the operator is looking at something else.
    if (takeFocus && lockScreen) {
      void lockScreen.offsetWidth;
      lockScreen.focus({ preventScroll: true });
    }

    // Quarter-second polling, not one second: the deadline is the truth and
    // this is only how often it is read, so a tab coming back repaints almost
    // at once rather than showing a stale number for a whole second.
    const tick = () => {
      if (paintLock() > 0) { lockTimer = setTimeout(tick, 250); return; }
      release();
    };
    lockTimer = setTimeout(tick, 250);
  }

  // A hidden tab stops painting entirely. Repaint the moment it comes back.
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && lockUntil) paintLock();
  });

  function release() {
    stopLock();
    // The lock ends the way a decline ends: the password goes, the badge goes
    // flat, and the paper is torn off so the next attempt starts on a clean
    // roll rather than under a spent TERMINAL LOCKED receipt.
    password.value = '';
    badge.setCharged(false);
    printer.tearOff();
    busy = false;
    submit.disabled = false;
    stage.set('idle');            // re-enables the controls via the subscription
    // Not setStatus('') - that restores the demo hint and would announce
    // "Demo - dan@counterpoint.co / openlane" as the outcome of a lockout.
    setStatus('Till unlocked. Enter your password to try again.', 'info');
    sync();
    password.focus();             // after enabling, or it is a no-op
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

    // login() may have degraded to the stand-in while this request was in
    // flight. Say so before reporting its answer.
    paintNet();

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
      // One reference, generated once, so the screen and the paper cannot
      // disagree across a minute boundary.
      const seconds = result.retryAfter || 30;
      const ref = lockRefFor();
      stage.set('locked');
      shudder();
      printer.print(lockedReceipt({ account: address, seconds, ref }), { reduced });
      lockdown(seconds, { ref });
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

  /* ---- Link state ---------------------------------------------------- *
     Painted from the auth client's live state rather than once from the boot
     probe. login() degrades to the offline stand-in the moment the service
     stops answering, and a header still reading Online while credentials are
     being checked against a map in the browser - under a different lock, from
     a different attempt count - is the screen telling the operator something
     that is not true. */
  function paintNet() {
    if (!net) return;
    net.textContent = authState.offline ? 'Offline' : 'Online';
    if (authState.offline) net.dataset.offline = '';
    else delete net.dataset.offline;
  }

  probe().then(() => {
    paintNet();
    if (authState.offline) {
      console.info('[auth] service unreachable - using the offline stand-in');
    }
    // A reload is not a way out. /api/health reports this caller's own lock
    // and the stand-in keeps its deadline in sessionStorage, so the notice
    // comes straight back up with the time that is actually left on it. No
    // receipt and no shudder: nothing has just been declined. And no focus
    // grab - the user asked for a page, not a panel.
    if (authState.locked && authState.retryAfter > 0) {
      // Reuse the reference and the time the lock was actually taken, so the
      // restored notice still matches the receipt that came out of the printer.
      const meta = recallLock() || {};
      busy = true;
      stage.set('locked');
      lockdown(authState.retryAfter, {
        takeFocus: false,
        ...(meta.ref ? { ref: meta.ref } : {}),
        ...(meta.clock ? { clock: meta.clock } : {}),
      });
    }
  });

  return { badge, sync, setStatus };
}
