// The stage state machine.
//
// One attribute on <html> is the single source of truth for what the whole
// counter is doing. Peripherals never decide their own state: the lane light,
// the card reader, the belt and the customer display all read from here.
//
// This table holds behaviour only - belt speed and the words on the reader.
// Every colour and animation lives in stage.css keyed off [data-state], so
// logic never hard-codes a hex and the palette never encodes a rule.

export const STATES = {
  // The lane is open and serving. Nothing is waiting on anyone.
  idle: {
    belt: 1,
    reader: '',
    note: 'Lane open, sale running',
  },

  // Someone has stepped up. The sale suspends but the belt keeps feeding.
  held: {
    belt: 1,
    reader: '',
    note: 'Sale held while the operator signs in',
  },

  // Credentials going in. The reader wakes and waits for the hand-off.
  entering: {
    belt: 1,
    reader: 'Ready',
    note: 'Reader armed',
  },

  // The pause after the card goes in. Everything in the scene holds still.
  authorising: {
    belt: 0,
    reader: 'Authorising\nDo not remove',
    note: 'Waiting on the server',
  },

  approved: {
    belt: 1,
    reader: 'Approved',
    note: 'Signed in',
  },

  declined: {
    belt: 0,
    reader: 'Declined',
    note: 'Refused, receipt printing',
  },

  // Too many attempts. The till stops trusting you, and the reader goes dark
  // with it - the supervisor message belongs on the terminal screen at step
  // 10. A dead reader still showing lit text would contradict itself.
  locked: {
    belt: 0,
    reader: '',
    note: 'Supervisor required',
  },
};

export const STATE_NAMES = Object.keys(STATES);

export class Stage {
  constructor({ lane = null, root = document.documentElement } = {}) {
    this.lane = lane;
    this.root = root;
    this.readerText = document.querySelector('.reader__text');
    this.current = null;
    this.listeners = new Set();
  }

  /**
   * Move the whole counter to a state. Later steps drive this from the form
   * and the auth service; for now it is switchable by hand.
   */
  set(name) {
    const state = STATES[name];
    if (!state) {
      console.warn(`[stage] unknown state "${name}" - staying on "${this.current}"`);
      return false;
    }
    if (name === this.current) return true;

    const previous = this.current;
    this.current = name;
    this.root.dataset.state = name;

    if (this.readerText) this.readerText.textContent = state.reader;
    if (this.lane) this.lane.setSpeedScale(state.belt);

    for (const fn of this.listeners) {
      try { fn(name, previous); }
      catch (err) { console.error('[stage] listener failed', err); }
    }
    return true;
  }

  /** Subscribe to transitions. Returns an unsubscribe function. */
  on(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  is(...names) { return names.includes(this.current); }
}
