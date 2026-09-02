// Entry point: form affordances, the ambient lane, and the stage that both
// of them will answer to from step 5 onward.

import './ui.js';
import { Lane } from './lane.js';
import { Stage } from './stage.js';

const lane = new Lane();
lane.start();

const stage = new Stage({ lane });

// ?state=authorising jumps straight to a state, which makes reviewing a
// single phase a link rather than a click-through.
const params = new URLSearchParams(location.search);
stage.set(params.get('state') || 'idle');

// Handles for tuning from the console while the design is in flux.
window.lane = lane;
window.stage = stage;

if (params.has('debug')) {
  import('./debug.js').then((m) => m.mount(stage)).catch(() => {});
}
