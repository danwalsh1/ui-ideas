// The staff badge assembles itself from the two fields.
//
// It is decoration built FROM the form and is never an input: the element
// carries aria-hidden, and the sign-in flow works identically with it
// switched off. See the note in badge.setCharged about length-blindness.

import { renderBarcode } from './barcode.js';

export class Badge {
  constructor(root) {
    this.root = root;
    this.idLine = root?.querySelector('.badge__id');
    this.code = root?.querySelector('.badge__code');
    this.value = '';

    // The barcode is laid out in pixels against the track, so a resize
    // has to redraw it rather than let the browser stretch the bars.
    window.addEventListener('resize', () => this.refresh(), { passive: true });
  }

  /** Email -> the printed line and the barcode. */
  setAccount(text) {
    if (!this.root) return;
    this.value = (text || '').trim();
    this.idLine.textContent = this.value || '—';
    this.root.classList.toggle('is-identified', Boolean(this.value));
    renderBarcode(this.code, this.value);
  }

  /**
   * Password -> the chip.
   *
   * Takes a boolean, never a length. The contacts run one fixed wake cycle
   * and then hold, so the badge confirms that something is being entered
   * without broadcasting how much of it there is to anyone stood behind
   * you at a counter.
   */
  setCharged(on) {
    this.root?.classList.toggle('is-charged', Boolean(on));
  }

  refresh() {
    if (this.root && this.value) renderBarcode(this.code, this.value);
  }

  reset() {
    this.setAccount('');
    this.setCharged(false);
  }
}
