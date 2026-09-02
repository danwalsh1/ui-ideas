// Basic form affordances for the sign-in pane.
//
// The build order lists step 2 as static, and the choreography (badge
// assembly, arming sequence, sale-held) is step 5. These two behaviours are
// pulled forward deliberately: "fully accessible" and "a reveal button that
// does nothing" are contradictory, and a Caps Lock warning that only appears
// later would let this step ship a form with a known silent failure mode.
//
// Nothing here animates and nothing here talks to a server.

const $ = (sel) => document.querySelector(sel);

const form = $('#signin-form');
const password = $('#password');
const reveal = $('#reveal');
const caps = $('#caps');

/* ---- Reveal ------------------------------------------------------- */
reveal.addEventListener('click', () => {
  const show = password.type === 'password';
  password.type = show ? 'text' : 'password';
  reveal.setAttribute('aria-pressed', String(show));
  reveal.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
  // Keep the caret where the user left it rather than jumping to the end.
  const { selectionStart, selectionEnd } = password;
  password.focus();
  try { password.setSelectionRange(selectionStart, selectionEnd); } catch { /* not supported on all types */ }
});

/* ---- Caps Lock ----------------------------------------------------- *
   Checked on both fields: a capitalised email is harmless, but people
   often notice the warning there first and fix it before the password. */
function checkCaps(event) {
  const on = typeof event.getModifierState === 'function' && event.getModifierState('CapsLock');
  caps.hidden = !on;
}

for (const el of [password, $('#email')]) {
  el.addEventListener('keydown', checkCaps);
  el.addEventListener('keyup', checkCaps);
  el.addEventListener('focus', checkCaps);
}
password.addEventListener('blur', () => { caps.hidden = true; });

/* ---- Submit -------------------------------------------------------- *
   There is no auth service until step 6. Swallow the submit so the page
   cannot navigate away, and leave the credentials untouched. */
form.addEventListener('submit', (event) => {
  event.preventDefault();
});
