// Phase 3a: being let in.
//
// The drawer bangs, the light rakes up across the counter, and the sign-in
// pane is pulled away like a receipt to reveal the app that was already
// underneath. No load, no fade to white - the login screen becomes the till.

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function runApproved({ user, lane, reduced, onDrawer }) {
  const pos = document.querySelector('.pos');
  const drawer = document.querySelector('.drawer');
  const rake = document.querySelector('.rake');

  // Name the operator before the app is revealed, so nothing is ever seen
  // with a placeholder in it.
  const name = document.querySelector('#home-name');
  const role = document.querySelector('#home-role');
  const shift = document.querySelector('#home-shift');
  if (name) name.textContent = user?.name || 'Operator';
  if (role) role.textContent = user?.role || 'Signed on';
  if (shift) {
    shift.textContent = new Date().toLocaleTimeString('en-GB', {
      hour: '2-digit', minute: '2-digit',
    });
  }

  // The till's own total carries across: the sale that was running by itself
  // is now the operator's opening sale. Ask the lane for the figure - the
  // odometer element holds ten digits per cell, not the one on show.
  const pay = document.querySelector('#home-total');
  if (pay) {
    pay.textContent = lane?.totalText ?? '£0.00';
    // Keep tracking it: the belt restarts on approval, so a figure captured
    // once here would be wrong within seconds.
    if (lane) lane.onTotal = (text) => { pay.textContent = text; };
  }

  await sleep(reduced ? 60 : 220);

  // The bang.
  drawer?.classList.add('is-open');
  onDrawer?.(1);
  // The spec is explicit that the drawer opens without the light rake, so the
  // class never goes on rather than going on and being neutered in CSS.
  if (!reduced) {
    rake?.classList.remove('is-on');
    void rake?.offsetWidth;               // restart the flare
    rake?.classList.add('is-on');
  }
  if (!reduced) {
    document.body.classList.add('is-jolt');
    setTimeout(() => document.body.classList.remove('is-jolt'), 440);
  }

  await sleep(reduced ? 80 : 300);

  // The pull-away. The app was there the whole time.
  const home = document.querySelector('.home');
  if (home) home.hidden = false;
  void home?.offsetWidth;
  pos?.classList.add('is-home');

  await sleep(reduced ? 120 : 700);
  drawer?.classList.remove('is-open');
  onDrawer?.(0.45);

  // The lane is the operator's now.
  lane?.setHold(false);
}

/** Back to the login, so the sequence can be run again. */
export function runSignOut({ badge }) {
  const pos = document.querySelector('.pos');
  const home = document.querySelector('.home');
  pos?.classList.remove('is-home');
  setTimeout(() => { if (home) home.hidden = true; }, 700);
  badge?.reset();
}
