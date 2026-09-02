// State switcher for hand-testing the stage. Loaded only when the page is
// opened with ?debug, so it never ships in the normal path.

import { STATE_NAMES, STATES } from './stage.js';

export function mount(stage) {
  const panel = document.createElement('div');
  panel.className = 'debug';
  panel.innerHTML = '<span class="debug__label">Stage</span>';

  const buttons = STATE_NAMES.map((name) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = name;
    b.title = STATES[name].note;
    b.addEventListener('click', () => stage.set(name));
    panel.appendChild(b);
    return b;
  });

  const sync = () => buttons.forEach((b) => {
    b.setAttribute('aria-pressed', String(b.textContent === stage.current));
  });
  stage.on(sync);
  sync();

  // Number keys switch states without reaching for the mouse.
  window.addEventListener('keydown', (e) => {
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    if (document.activeElement?.matches('input, textarea')) return;
    const i = Number(e.key) - 1;
    if (i >= 0 && i < STATE_NAMES.length) stage.set(STATE_NAMES[i]);
  });

  document.body.appendChild(panel);
}
