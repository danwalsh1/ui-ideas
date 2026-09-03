// Phase 2: the badge hand-off.
//
// Two beats, and they map onto the two fields. The barcode is the part the
// shop can see, so it goes under the scanner - the same beep the goods have
// been making for the last minute, which is what makes it land. The chip is
// the part only the machine knows, so it goes into the card reader.
//
// The badge travels at body level: the terminal screen clips its contents,
// and the badge has to leave the screen, cross the counter and reach the
// reader. So a clone flies while the real one folds away with the pane.

const EASE = 'cubic-bezier(0.36, 0.7, 0.28, 1)';

const centre = (r) => ({ x: r.left + r.width / 2, y: r.top + r.height / 2 });

function play(el, frames, duration, easing = EASE) {
  const anim = el.animate(frames, { duration, easing, fill: 'forwards' });
  // Never let the sequence wait on a frame that may not come. A backgrounded
  // tab throttles or suspends these, and the sign-in must not hang because
  // nobody is looking at it: past the deadline, snap to the end and move on.
  return Promise.race([
    anim.finished,
    new Promise((resolve) => setTimeout(resolve, duration + 400)),
  ]).then(() => { try { anim.finish(); } catch { /* already done */ } });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Build a travelling copy of the badge: barcode, chip, laminate. */
function buildFlyer(badgeEl) {
  const fly = document.createElement('div');
  fly.className = 'badge-fly';

  const code = document.createElement('div');
  code.className = 'badge-fly__code';
  const svg = badgeEl.querySelector('.badge__code svg');
  if (svg) {
    const copy = svg.cloneNode(true);
    // The holder scrolls a long code to its tail; in the air, show the head.
    copy.style.translate = '0 0';
    code.appendChild(copy);
  }

  const chip = document.createElement('div');
  chip.className = 'badge-fly__chip';

  fly.append(code, chip);
  return fly;
}

/**
 * Run the hand-off. Resolves once the badge is in the reader, so the caller
 * can wait on it alongside the request and never resolve mid-flight.
 */
export async function runHandoff({ badgeEl, scannerEl, glassEl, readerEl, slotEl, reduced, onScan }) {
  // Reduced motion skips the flight entirely - the takeover screen and the
  // reader still change state, so nothing is lost but the travel. A hidden
  // tab skips it for the same reason: there is no one to show it to, and
  // playing it out would only delay the outcome.
  if (reduced || document.hidden || !badgeEl || !glassEl || !slotEl) return;

  const from = badgeEl.getBoundingClientRect();
  if (!from.width) return;

  // The scanner and the reader are hidden on narrow layouts, and a hidden
  // element still answers querySelector. Their rects come back zero, so the
  // badge would fly to the top-left corner of the viewport, bounce there for
  // the read, and sink into nothing - two and a half seconds of visible
  // garbage over the one pause the sequence is built around. The badge itself
  // is never hidden, so the check above does not catch it.
  if (!glassEl.getClientRects().length || !slotEl.getClientRects().length) return;

  // Card proportions, not the holder's. The holder is a wide slot because
  // that is the shape the pane gives it; once it is out and in the air it
  // has to read as a staff badge. It fades in on the lift, so the change
  // from slot to card is never seen as a jump.
  const width = Math.max(150, Math.min(212, from.width * 0.55));
  const fly = buildFlyer(badgeEl);
  fly.style.width = `${Math.round(width)}px`;
  fly.style.height = `${Math.round(width * 0.63)}px`;
  fly.style.fontSize = `${(width / 14).toFixed(2)}px`;
  document.body.appendChild(fly);

  const size = fly.getBoundingClientRect();
  const at = (x, y, rot = 0, scale = 1) =>
    `translate(${Math.round(x - size.width / 2)}px, ${Math.round(y - size.height / 2)}px) rotate(${rot}deg) scale(${scale})`;

  const start = centre(from);
  const glass = centre(glassEl.getBoundingClientRect());
  const slot = centre(slotEl.getBoundingClientRect());

  try {
    // 1. Lift out of the holder.
    await play(fly, [
      { transform: at(start.x, start.y, 0, 0.96), opacity: 0 },
      { transform: at(start.x, start.y - 14, -1.5, 1.02), opacity: 1 },
    ], 300);

    // 2. Arc down to the scanner glass, turning flat as it goes.
    await play(fly, [
      { transform: at(start.x, start.y - 14, -1.5, 1.02) },
      { transform: at((start.x + glass.x) / 2, Math.min(start.y, glass.y) - 70, -6, 0.86), offset: 0.45 },
      { transform: at(glass.x, glass.y, -2, 0.72) },
    ], 720);

    // 3. The read. Same beam, same glow - and the same beep - the goods get.
    scannerEl?.classList.add('is-reading');
    // Fired at the start of the beat, never scheduled forward: a throttled tab
    // snaps each leg to its end and the sound would arrive in a heap.
    onScan?.();
    await play(fly, [
      { transform: at(glass.x, glass.y, -2, 0.72) },
      { transform: at(glass.x, glass.y + 3, -2, 0.70), offset: 0.4 },
      { transform: at(glass.x, glass.y, -2, 0.72) },
    ], 300, 'ease-out');
    scannerEl?.classList.remove('is-reading');

    // 4. On to the reader, righting itself for the slot.
    await play(fly, [
      { transform: at(glass.x, glass.y, -2, 0.72) },
      { transform: at((glass.x + slot.x) / 2, Math.min(glass.y, slot.y) - 78, 5, 0.66), offset: 0.5 },
      { transform: at(slot.x, slot.y - 26, 0, 0.5) },
    ], 620);

    // 5. Contacts first. It goes in and stays in.
    await play(fly, [
      { transform: at(slot.x, slot.y - 26, 0, 0.5), opacity: 1 },
      { transform: at(slot.x, slot.y + 6, 0, 0.44), opacity: 0 },
    ], 420, 'cubic-bezier(0.5, 0, 0.75, 0)');
  } catch {
    // An interrupted animation is not a failure worth surfacing.
  } finally {
    scannerEl?.classList.remove('is-reading');
    fly.remove();
  }

  // A held beat before the caller resolves, so the reader is visibly in
  // charge before anything else happens.
  await sleep(120);
}
