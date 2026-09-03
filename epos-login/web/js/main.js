// Entry point: form affordances, the ambient lane, and the stage that both
// of them will answer to from step 5 onward.

import { initForm } from './ui.js';
import { Lane } from './lane.js';
import { Stage } from './stage.js';
import { SoundKit } from './sound.js';
import { initAttract } from './attract.js';

const lane = new Lane();
lane.start();

// Built here and nowhere else. Constructing it touches no Web Audio at all -
// the context arrives with the toggle's first click.
const sound = new SoundKit();
lane.onScan = () => sound.beep();
lane.onBag = () => sound.bag();

const stage = new Stage({ lane });
stage.on((name) => sound.setState(name));
initForm({ stage, lane, sound });

// Step 12. Mounted before the first stage.set so the boot transition arms it -
// including a ?state= jump into locked, which must not arm it at all.
const attract = initAttract({ stage });

// An AudioContext keeps running in a hidden tab while the scene's frame loop
// starves, so the room would play on over a frozen set.
document.addEventListener('visibilitychange', () => sound.setVisible(!document.hidden));

// ?state=authorising jumps straight to a state, which makes reviewing a
// single phase a link rather than a click-through.
const params = new URLSearchParams(location.search);
stage.set(params.get('state') || 'idle');

// Handles for tuning from the console while the design is in flux.
window.lane = lane;
window.stage = stage;
window.sound = sound;
window.attract = attract;

if (params.has('debug')) {
  import('./debug.js').then((m) => m.mount(stage)).catch(() => {});
}
