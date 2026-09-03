// Barcode rendering for the staff badge.
//
// HONESTY NOTE: this draws a barcode in the *grammar* of Code 128 - quiet
// zone, start guard, eleven-module character cells, a check cell and a
// thirteen-module stop guard - but it is a faithful rendering, not a
// scannable symbol. Real Code 128 needs its 107-entry pattern table, and
// shipping one I could not verify would be worse than saying plainly that
// this is a representation. The bars are still fully deterministic: the
// same address always draws the same code.
//
// The character cells are generated rather than tabulated: every way of
// splitting eleven modules into six alternating runs of one to four is a
// valid Code 128 cell shape, so the pattern space is computed at load.

const CELL_MODULES = 11;

/** Every 6-run composition of 11 with each run in 1..4. 216 of them. */
function buildCells() {
  const out = [];
  for (let a = 1; a <= 4; a++)
    for (let b = 1; b <= 4; b++)
      for (let c = 1; c <= 4; c++)
        for (let d = 1; d <= 4; d++)
          for (let e = 1; e <= 4; e++) {
            const f = CELL_MODULES - (a + b + c + d + e);
            if (f >= 1 && f <= 4) out.push([a, b, c, d, e, f]);
          }
  return out;
}

const CELLS = buildCells();
const START = [2, 1, 1, 4, 1, 2];        // 11 modules
const STOP = [2, 3, 3, 1, 1, 1, 2];      // 13 modules, 7 runs
const QUIET = 6;
const MIN_MODULE = 1;
const MAX_MODULE = 2.4;

/**
 * Build the run-length sequence for a string. Runs alternate bar, space,
 * bar, ... starting with a bar, exactly as Code 128 does.
 */
function encode(text) {
  const runs = [...START];
  let checksum = 104;                    // Start B, as the real thing uses

  [...text].forEach((ch, i) => {
    const value = (ch.codePointAt(0) - 32) % CELLS.length;
    const index = value < 0 ? 0 : value;
    runs.push(...CELLS[index]);
    checksum += index * (i + 1);
  });

  runs.push(...CELLS[checksum % CELLS.length]);
  runs.push(...STOP);
  return runs;
}

/**
 * Draw into `host`. Returns the drawn width in modules so the caller can
 * decide whether the badge needs to scroll.
 */
export function renderBarcode(host, text) {
  if (!host) return 0;

  if (!text) {
    host.replaceChildren();
    host.style.removeProperty('--code-shift');
    return 0;
  }

  const runs = encode(text);
  const modules = runs.reduce((a, b) => a + b, 0) + QUIET * 2;

  // Fit the track if it can, then stop shrinking. Below about a pixel a
  // barcode stops looking like bars and starts looking like grey noise, so
  // past that point the badge scrolls to the end instead.
  const track = host.clientWidth || 200;
  const module = Math.min(MAX_MODULE, Math.max(MIN_MODULE, track / modules));
  const width = modules * module;

  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('width', String(width));
  svg.setAttribute('height', '100%');
  svg.setAttribute('viewBox', `0 0 ${modules} 10`);
  svg.setAttribute('preserveAspectRatio', 'none');
  svg.setAttribute('aria-hidden', 'true');

  // One path for the whole symbol rather than a rect per bar.
  let d = '';
  let x = QUIET;
  runs.forEach((run, i) => {
    if (i % 2 === 0) d += `M${x} 0h${run}v10h${-run}z`;   // even runs are bars
    x += run;
  });

  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', d);
  path.setAttribute('fill', 'currentColor');
  svg.appendChild(path);

  host.replaceChildren(svg);

  // Show the tail when the code is longer than the track, the way a printed
  // label runs off the edge of a badge.
  const overflow = Math.max(0, width - track);
  host.style.setProperty('--code-shift', `${-overflow}px`);
  return width;
}
