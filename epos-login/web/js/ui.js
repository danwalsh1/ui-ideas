// The sign-in form, and the choreography it drives.
//
// Phase 1: focusing a field holds the sale, typing an address assembles the
// badge, and a password arms the counter. The form only ever moves the stage
// between idle / held / entering - once authorising or a resolution owns the
// stage, the form keeps its hands off.

import { Badge } from './badge.js';

const $ = (sel) => document.querySelector(sel);

// The states the form is allowed to drive. Anything else belongs to the
// auth sequence in later steps and must not be stomped on by a blur.
const FORM_STATES = ['idle', 'held', 'entering'];

export function initForm({ stage }) {
  const form = $('#signin-form');
  const email = $('#email');
  const password = $('#password');
  const reveal = $('#reveal');
  const caps = $('#caps');
  const forgot = $('#forgot');
  const recall = $('#fkey-recall');
  const badge = new Badge($('.badge'));

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
  email.addEventListener('input', () => badge.setAccount(email.value));
  password.addEventListener('input', () => {
    badge.setCharged(password.value.length > 0);
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
     The only function key that does anything yet, so it is the only one
     rendered as a button. It moves focus to password recovery, which is
     what Recall means on a till: bring back what was set aside. */
  function recallPassword() {
    forgot.focus();
  }
  recall.addEventListener('click', recallPassword);
  window.addEventListener('keydown', (event) => {
    if (event.key !== 'F1') return;
    event.preventDefault();
    recallPassword();
  });

  /* ---- Submit -------------------------------------------------------- *
     There is no auth service until step 6. Swallow the submit so the page
     cannot navigate away, and leave the credentials untouched. */
  form.addEventListener('submit', (event) => event.preventDefault());

  return { badge, sync };
}
