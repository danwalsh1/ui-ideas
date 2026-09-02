// Entry point. Wires the form affordances and starts the ambient lane.
// Step 4 introduces the central state machine and will take ownership of
// the lane's speed and pause state from here.

import './ui.js';
import { Lane } from './lane.js';

const lane = new Lane();
lane.start();

// Handle for tuning from the console while the design is in flux.
window.lane = lane;
