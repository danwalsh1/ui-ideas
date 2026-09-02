# The Kinetic Topography

A desktop login experience where the background *is* the interface. Hundreds of
thousands of GPU-simulated particles form a living topographic landscape that
reacts to the cursor, detonates under each keystroke, collapses into a spinning
gyroscope while the server verifies your credentials, and then either blooms
into the dashboard or shatters into crimson dust and reassembles the form.

No spinner. No page load. No frameworks, no build step, no npm install.

## Run it

```bash
docker compose up -d
```

Then open <http://localhost:8088>.

```bash
docker compose down
```

Two containers: `nginx` serves the static client, and a dependency-free Node
service handles `/api/login`. The client falls back to an equivalent in-browser
stand-in if the API is unreachable, so the choreography can always be seen (the
panel footer tells you which one is live).

### Credentials

| Operator ID | Passphrase   |
| ----------- | ------------ |
| `operator`  | `topography` |
| `dan`       | `kinetic`    |
| `demo`      | `demo1234`   |

Anything else takes the failure path — which is the more interesting one to watch.

## What to try

- **Move the cursor.** Particles are pulled toward it and leave glowing wakes.
  **Hold the mouse button** to invert it and push them away instead.
- **Click into a field.** The topography lifts and a shell of particles begins
  wheeling around the glass panel.
- **Type a passphrase.** Every character fires a shockwave through the grid, and
  the scene ramps from calm cyan to kinetic violet as the passphrase gains weight.
- **Submit.** The panel shatters into the field, the camera pushes forward, and
  the particles snap into a spinning astrolabe for as long as the server takes.
- **Sign out** from the dashboard to run it again.
- **HUD, bottom right:** sound (synthesised live — no audio files), motion, and
  particle density.

## Layout

```
docker-compose.yaml   two services: web (nginx) + api (node)
nginx/default.conf    static serving, /api proxy
server/server.js      auth service, zero dependencies
web/index.html        login panel + dashboard, one document
web/css/app.css       glassmorphism, states, dashboard
web/js/field.js       the particle engine: sim, camera, post chain
web/js/shaders.js     all GLSL
web/js/app.js         choreography - the director for the whole sequence
web/js/audio.js       synthesised sound design
web/js/auth.js        API client + offline fallback
web/js/{math,glutil}.js
```

## How the field works

`field.js` is a dumb physics box; `app.js` directs it. Nothing is a canned
animation — every visual state is a **target field** that particles spring
toward, so a state change is a physical migration rather than a cut.

- **Simulation** — ping-pong MRT over two `RGBA32F` textures (position,
  velocity), one texel per particle. Formations (`topography`, `panel`, `orbit`,
  `gyroscope`) are pure functions of a per-particle hash, so there is no
  per-particle CPU work at all.
- **Trails** — the scene is an HDR ping-pong pair; each frame redraws the last
  one at a per-mode decay before compositing particles additively. Trails come
  free, and `decay` is what tunes them from *ethereal wake* to *warp streak*.
- **Post** — soft-knee bright pass into a three-level separable gaussian, then a
  composite doing chromatic aberration, block-tear glitch, ACES tonemap,
  vignette and grain.
- **Camera** — the glass panel's world-space frame is projected from the live
  DOM `getBoundingClientRect()`, so the particle silhouette tracks the real
  element (including while it shudders). It is frozen at submit so the
  gyroscope inherits exactly where the panel was.

### Two things worth knowing if you tune it

**A spring is a low-pass filter.** The gyroscope rings turn at ~23 rad/s while a
stable spring sits near 4 rad/s, so a pure spring parks every particle at the
*time-average* of its target — the centre — and the structure collapses into a
ball. Fast formations therefore use `snap` (a frame-rate-independent positional
lock) instead of stiffness.

**`decay` and `bright` are coupled.** The trail buffer accumulates roughly
`1/(1-decay)` frames of light. Warp's `0.968` is a 31× multiplier, so its
per-particle brightness has to be ~20× lower than idle's for the same exposure.
`point` and `bright` trade off the same way against how tightly a formation
packs. All of it lives in one table at the top of `field.js`.

## Requirements and fallbacks

Needs **WebGL2** with float render targets (`EXT_color_buffer_float`). Without
them the page drops to an animated CSS gradient and the entire login flow —
including the failure and success sequences — still works.

- Density adapts to the machine and can be overridden in the HUD; the renderer
  also scales resolution down automatically if it starts missing frames.
- `prefers-reduced-motion` is honoured and can be toggled at runtime: the
  gyroscope still appears, but the camera dolly and warp are skipped.
- Audio only starts after a user gesture and is off by default.
- The choreography runs on timers rather than frame delivery, so backgrounding
  the tab mid-login cannot strand the sequence.

`window.kineticField` is exposed for live tuning from the console.
