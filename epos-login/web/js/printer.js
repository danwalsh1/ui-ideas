// The receipt printer.
//
// The printed receipt is decoration: the real message goes to the live region
// in the form and is readable as plain text on the terminal screen. What this
// adds is the physical record - and the reason a third failure feels
// different from a first without anyone having to read a counter.

const WIDTH = 21;                 // characters across the paper
const RULE = '-'.repeat(WIDTH);
const DOUBLE = '='.repeat(WIDTH);
const MAX_STACK = 5;              // matches the lockout threshold

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const centre = (text) => {
  const t = text.slice(0, WIDTH);
  return ' '.repeat(Math.max(0, Math.floor((WIDTH - t.length) / 2))) + t;
};

/** "TILL 04    09:41:22" - left and right, filled to the paper width. */
const cols = (left, right) => {
  const l = String(left);
  const r = String(right);
  const gap = Math.max(1, WIDTH - l.length - r.length);
  return l + ' '.repeat(gap) + r;
};

const clip = (text) => String(text).slice(0, WIDTH);

const now = () => new Date().toLocaleTimeString('en-GB', { hour12: false });

// The screen prints the same shape, so the paper in the operator's hand and
// the plate behind the glass quote each other character for character.
const mmss = (s) =>
  `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(Math.round(s) % 60).padStart(2, '0')}`;

/* ------------------------------------------------------------------ *
 * Receipt content
 * ------------------------------------------------------------------ */
export function declinedReceipt({ account, attempt, of }) {
  const rows = [
    { brand: true },
    { text: centre('COUNTERPOINT'), cls: 'head' },
    { text: DOUBLE, cls: 'rule' },
    { text: centre('DECLINED'), cls: 'head' },
    { text: RULE, cls: 'rule' },
    { text: cols('TILL 04', now()) },
    { text: clip(account), cls: 'dim' },
    { text: RULE, cls: 'rule' },
    { text: 'INVALID CREDENTIALS' },
  ];
  if (attempt && of) rows.push({ text: cols('ATTEMPT', `${attempt} OF ${of}`) });
  rows.push({ text: RULE, cls: 'rule' }, { text: centre('PLEASE TRY AGAIN') });
  return rows;
}

export function lockedReceipt({ account, seconds, ref }) {
  return [
    { brand: true },
    { text: centre('COUNTERPOINT'), cls: 'head' },
    { text: DOUBLE, cls: 'rule' },
    { text: centre('TERMINAL LOCKED'), cls: 'head' },
    { text: RULE, cls: 'rule' },
    { text: cols('TILL 04', now()) },
    { text: clip(account), cls: 'dim' },
    // One reference on two surfaces. A number you can read down a phone is
    // what turns an error message into something a manager can be told about.
    { text: cols('REF', ref || ''), cls: 'dim' },
    { text: RULE, cls: 'rule' },
    { text: cols('RETRY IN', mmss(seconds)) },
    { text: RULE, cls: 'rule' },
    { text: centre('CALL MANAGER') },
  ];
}

export function signOnReceipt({ name, role }) {
  return [
    { brand: true },
    { text: centre('COUNTERPOINT'), cls: 'head' },
    { text: DOUBLE, cls: 'rule' },
    { text: centre('SIGNED ON'), cls: 'head' },
    { text: RULE, cls: 'rule' },
    { text: clip(String(name || 'Operator').toUpperCase()) },
    { text: clip(String(role || '').toUpperCase()), cls: 'dim' },
    { text: cols('TILL 04', now()) },
    { text: RULE, cls: 'rule' },
  ];
}

/* ------------------------------------------------------------------ */
export class Printer {
  constructor() {
    this.printer = document.querySelector('.printer');
    this.out = document.querySelector('.printer__out');
    this.stack = [];
    this.onTear = null;   // paper pulled across the bar
  }

  get hasPaper() { return this.stack.length > 0; }

  _build(rows) {
    const receipt = document.createElement('div');
    receipt.className = 'receipt';

    const sheet = document.createElement('div');
    sheet.className = 'receipt__sheet';

    for (const row of rows) {
      if (row.brand) {
        const wrap = document.createElement('div');
        wrap.className = 'receipt__brand';
        wrap.innerHTML = '<svg viewBox="0 0 32 32"><use href="#cp-mark"/></svg>';
        sheet.appendChild(wrap);
        continue;
      }
      const line = document.createElement('div');
      line.className = 'receipt__row' + (row.cls ? ` receipt__row--${row.cls}` : '');
      line.textContent = row.text;
      sheet.appendChild(line);
    }

    const tear = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    tear.setAttribute('class', 'receipt__tear');
    tear.setAttribute('viewBox', '0 0 84 5');
    tear.setAttribute('preserveAspectRatio', 'none');
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', 'M0 0h84v0l-6 5-6-5-6 5-6-5-6 5-6-5-6 5-6-5-6 5-6-5-6 5-6-5-6 5-6-5z');
    path.setAttribute('fill', 'currentColor');
    tear.appendChild(path);

    receipt.append(sheet, tear);
    return { receipt, sheet };
  }

  /**
   * Fit the type to the paper so that all WIDTH characters land on the stock.
   *
   * Measured rather than declared. print() measures the sheet synchronously in
   * the same tick it is appended, and a CSS value that has not resolved by
   * then - a container query unit, or a token that lands a moment later -
   * computes to zero, which collapses every row to no height and feeds out a
   * blank receipt. A number taken from the element in hand cannot do that, and
   * it self-corrects to whatever width the printer ends up at.
   *
   * The divisor is WIDTH monospace advances (about 0.58em each) plus the
   * sheet's 1.4em of horizontal padding, with a little room to spare.
   */
  _fit(sheet) {
    const paper = this.out?.clientWidth || 0;
    if (!paper) return;
    sheet.style.fontSize = `${Math.min(9, paper / (WIDTH * 0.58 + 1.8)).toFixed(2)}px`;
  }

  /** Shove what is already hanging further out and further askew. */
  _shove() {
    const n = this.stack.length;
    this.stack.forEach((el, i) => {
      const depth = n - i;                       // 1 = printed most recently
      el.style.zIndex = String(20 - depth);
      el.style.transform =
        `translate(calc(-50% + ${depth * -5}px), ${depth * 15}px) rotate(${depth * -3.2}deg)`;
    });
  }

  async print(rows, { reduced = false, onStep = null } = {}) {
    if (!this.out) return;

    this._shove();
    while (this.stack.length >= MAX_STACK) this.stack.shift()?.remove();

    const { receipt, sheet } = this._build(rows);
    this._fit(sheet);
    receipt.style.zIndex = '21';
    receipt.style.transform = 'translate(-50%, 0) rotate(0deg)';
    this.out.appendChild(receipt);
    this.stack.push(receipt);

    // The sheet rests at its own height. Measuring only decides where the
    // stutter pauses; it never decides how tall the finished receipt is.
    sheet.classList.add('is-fed');

    // Presented whole rather than stuttered out. A document that is not being
    // rendered gets the same treatment twice over: its timers are clamped to
    // about a second, so stepping row by row would turn a three-quarter-second
    // feed into a twelve-second crawl, and every layout read comes back zero,
    // so there would be nothing to step through anyway.
    if (reduced || document.hidden) {
      // One continuous feed rather than a stutter: there are no visible steps
      // to sync to, and a fake step loop would be sound narrating motion that
      // is deliberately not happening.
      onStep?.({ whole: true });
      return;
    }

    // Where each row ends, so the paper pauses on row boundaries.
    const padBottom = parseFloat(getComputedStyle(sheet).paddingBottom) || 0;
    const stops = [...sheet.children].map((el) => el.offsetTop + el.offsetHeight);
    if (stops.length) stops[stops.length - 1] += padBottom;
    if (!stops.length || !stops[stops.length - 1]) return;   // nothing to measure

    sheet.classList.remove('is-fed');
    sheet.style.height = '0px';
    this.printer?.classList.add('is-printing');
    for (const stop of stops) {
      if (!receipt.isConnected) break;          // torn off mid-print
      sheet.style.height = `${stop}px`;
      onStep?.({ whole: false });             // never awaited
      // A stepper does not glide: a few millimetres, a pause, a few more.
      await sleep(46 + Math.random() * 26);
    }
    this.printer?.classList.remove('is-printing');
    // Hand the height back to the stylesheet.
    sheet.style.height = '';
    sheet.classList.add('is-fed');
  }

  /** Tear the drift off. It drops out of frame. */
  tearOff() {
    if (!this.stack.length || !this.out) return;
    this.onTear?.();      // after the guard: this is bound to every keystroke
    const gone = this.stack;
    this.stack = [];
    this.out.classList.add('is-tearing');
    gone.forEach((el, i) => {
      el.style.transform = `translate(-50%, ${180 + i * 12}px) rotate(${-13 - i * 4}deg)`;
      el.style.opacity = '0';
    });
    setTimeout(() => {
      gone.forEach((el) => el.remove());
      this.out.classList.remove('is-tearing');
    }, 620);
  }
}
