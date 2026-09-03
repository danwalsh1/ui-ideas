// Phase 0: attract mode.
//
// Sixty seconds with nobody at the counter and the terminal's backlight drops
// to the mark. Any input wakes it. The rest of the set never hears about it -
// the belt keeps running, the lane light stays green, and the sale keeps
// totalling behind the dim. Sixty seconds later the total has gone up, which
// is the point: the till dimmed, the shop did not stop.
//
// This is why it is not a stage state. data-state is what the whole counter is
// doing, and the counter is doing exactly what it was a second ago; one
// surface changes, so one attribute drives it. An eighth STATES entry would
// duplicate idle's four values, move the audio beds through the stage
// subscription, and put a button reading "attract" in the debug switcher
// beside "locked".

// The spec's number. Shorter and this stops being a till that dimmed and
// becomes a trick that fires while you are still reading the form.
const ATTRACT_AFTER = 60000;

// The idle clock only runs in idle. held and entering have someone standing at
// the till with a caret in a field; authorising has a request in flight;
// approved has an operator signed on, which is the definition of attended;
// declined has a receipt to read and lasts under a second anyway; and locked
// has a countdown running, which is a promise no logo may cover.
const ELIGIBLE = ['idle'];

// A stationary cursor still receives pointermove when layout moves beneath it,
// and the belt moves beneath it about sixty times a second. Those events
// report the same coordinates, so a distance gate rejects every one of them
// and a debounce would reject none. Idleness has to mean the user is idle, not
// that the page is.
const WAKE_PX = 6;

export function initAttract({ stage, root = document.documentElement, after = readParam() } = {}) {
  let last = performance.now();
  let timer = 0;
  let on = false;
  let px = 0;
  let py = 0;

  const eligible = () => ELIGIBLE.includes(stage.current);

  /* ---- The clock --------------------------------------------------- *
     A deadline, not a decrement - the same reason the lockout gives.
     setTimeout drifts and a hidden tab clamps it, and this one is armed for a
     minute at a time. Activity writes a timestamp and nothing else; the timer
     discovers the remainder when it fires, so a page being typed into
     schedules one timeout per idle window rather than one per keystroke. */
  function arm() {
    if (timer || after <= 0 || document.hidden || !eligible()) return;
    timer = setTimeout(tick, after);
  }

  function tick() {
    timer = 0;
    if (document.hidden || !eligible()) return;
    const left = after - (performance.now() - last);
    if (left > 0) { timer = setTimeout(tick, Math.max(left, 50)); return; }
    on = true;
    root.setAttribute('data-attract', '');
  }

  function stop() { clearTimeout(timer); timer = 0; }

  function wake() {
    if (!on) return;
    on = false;
    root.removeAttribute('data-attract');
  }

  /* ---- Activity ----------------------------------------------------- *
     Nothing in here calls preventDefault or stopPropagation, and nothing moves
     focus. That is the whole of the wake policy:

       Keys are never swallowed. The panel holds nothing focusable and this
       never focuses anything, so a keystroke reaches the element it was always
       going to reach and wakes the screen on the way past. Eating it would
       lose a character of a password silently, would break autofill, and would
       break F4 - which is deliberately left ungated because killing the sound
       has to work under a takeover, and a dark screen still making noise is
       exactly when you want it.

       Pointers ARE swallowed, by geometry rather than by code: the panel takes
       pointer-events while it is up, so the click lands on it. A click aimed
       at a control nobody can see is a guess at where one used to be, and the
       guesses on offer here are "reveal the password" and "submit an empty
       form". On touch, a first tap meaning "wake up" is what every device in
       the user's pocket already does. */
  function bump() {
    last = performance.now();
    wake();
    arm();
  }

  const opts = { passive: true, capture: true };

  addEventListener('pointermove', (event) => {
    const dx = event.clientX - px;
    const dy = event.clientY - py;
    if (dx * dx + dy * dy < WAKE_PX * WAKE_PX) return;
    px = event.clientX;
    py = event.clientY;
    bump();
  }, opts);

  // pointerdown covers touch; input covers the autofill and paste that do not
  // always arrive as keystrokes, which is the same hazard the badge already
  // handles. focusin bubbles to window, and is what makes a keyboard user's
  // first Tab a wake rather than a Tab into the dark.
  for (const type of ['pointerdown', 'wheel', 'keydown', 'focusin', 'input']) {
    addEventListener(type, bump, opts);
  }

  /* A hidden tab is not somebody ignoring the till - it is a till that is not
     on screen, with a starved frame loop behind it. Counting that time as idle
     would put a dimmed screen over a frozen belt, which is the inverse of the
     one thing this feature is for. So the clock stops, and coming back counts
     as arriving. */
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { stop(); return; }
    bump();
  });

  /* Every exit from idle takes the screen back instantly - including the exit
     this panel just caused by waking, where it has already gone. */
  stage.on((name) => {
    if (ELIGIBLE.includes(name)) { last = performance.now(); arm(); return; }
    wake();
    stop();
  });

  // For the case where this is mounted after the stage already has a state.
  // Mounted before it, as main.js does, the boot transition arms it instead.
  arm();

  return { wake, stop };
}

/* ?attract=8 runs it at eight seconds so the feature can be reviewed without
   waiting a minute, and ?attract=off turns it off. Seconds rather than
   milliseconds, because nobody wants to type 60000 to look at something. Same
   idiom as ?state= and ?debug. */
function readParam() {
  const raw = new URLSearchParams(location.search).get('attract');
  if (raw === null) return ATTRACT_AFTER;
  if (raw === 'off' || raw === '0') return 0;
  const secs = Number(raw);
  return Number.isFinite(secs) && secs > 0 ? secs * 1000 : ATTRACT_AFTER;
}
