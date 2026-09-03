# The Open Lane

## A login experience for an EPOS company

The login form lives inside the screen of a modern countertop till, sitting on a
sunlit shop counter. The terminal is not a picture of a till — every peripheral
around it is a working part of the interface. The scanner reads your badge. The
card reader is the status light. The receipt printer is the error channel. The
cash drawer is the transition into the app.

The form itself is ordinary on purpose: **email and password**, the way every
other web app does it, with password managers and autofill working exactly as
expected. All the retail character lives in what the counter does around it.

And the till is never idle. Before you touch anything it is already working:
items travel the belt, get scanned, and total up on screen, the way a lane looks
from across a shop floor.

**Key insight:** every other login screen asks you to *wait for the system*. A
till never waits — it authorises. Reframing sign-in as a transaction being
authorised turns the loading state from dead time into the most familiar
suspense in retail: the pause after the card goes in, before the machine decides.

---

## Contents

- [Art direction](#art-direction)
- [The set](#the-set)
- [Brand slot](#brand-slot)
- [Phase 0 — Idle: the open lane](#phase-0--idle-the-open-lane)
- [Phase 1 — Input: clocking on](#phase-1--input-clocking-on)
- [Phase 2 — Authorising](#phase-2--authorising)
- [Phase 3a — Approved](#phase-3a--approved)
- [Phase 3b — Declined](#phase-3b--declined)
- [Phase 3c — Supervisor lockout](#phase-3c--supervisor-lockout)
- [Details worth the effort](#details-worth-the-effort)
- [Sound design](#sound-design)
- [Accessibility and reduced motion](#accessibility-and-reduced-motion)
- [Responsive behaviour](#responsive-behaviour)
- [Technical approach](#technical-approach)
- [Build order](#build-order)
- [Decisions to confirm](#decisions-to-confirm)

---

## Art direction

The previous concept lived in the dark. This one is the opposite and should
commit to it: **bright, warm, tactile, mid-morning**. Their product only ships a
light theme, so light is not a compromise here — it is the whole aesthetic.

In a dark scene, glow does the work. In a light scene, **material and shadow**
do. That is the discipline this design has to hold: soft layered shadows, real
surface texture, honest highlights on glass and brushed metal. Nothing should
float without casting something.

**Palette**

| Token | Value | Use |
| --- | --- | --- |
| `--paper` | `#FCFBF8` | Receipt stock, card surfaces |
| `--counter` | `#EDE7DD` | Counter surface, warm neutral |
| `--counter-shade` | `#DDD4C7` | Counter shadow and edge |
| `--shell` | `#2B3037` | Terminal bezel and stand, charcoal |
| `--screen` | `#FFFFFF` | Terminal screen base |
| `--surface` | `#F4F6F9` | Panels inside the screen UI |
| `--ink` | `#161D26` | Primary text |
| `--ink-soft` | `#5A6675` | Secondary text |
| `--rule` | `#E2E6EC` | Hairlines and dividers |
| `--brand` | `#4356E0` | **Replaceable.** Accent, active states |
| `--approved` | `#16A45A` | Success only |
| `--declined` | `#D8332F` | Failure only |
| `--pending` | `#E8930C` | Authorising only |

Brand accent and semantic colours stay strictly separate — the accent never
means "good", and green never means "brand". That way a customer can drop in a
red or amber brand colour without the interface lying about a transaction.

**Type**

- **Interface:** a clean grotesque (Inter, or the system stack). Tight, neutral,
  confident. Tabular numerals everywhere a figure can change.
- **Receipt and till readouts:** monospace, letter-spaced, with a faint ink
  bleed and slight baseline jitter. It should look *printed*, not typeset.
- **Totals:** oversized, tabular, near-black. The total is the loudest number on
  the screen because it is the loudest number in a shop.

**Materials to get right**

- Screen glass: a broad, soft specular sweep that tracks the cursor, plus a
  barely-there reflection of the room.
- Bezel: matte charcoal with a 1px top highlight and a warm bounce light from
  the counter underneath.
- Receipt paper: slightly warm white, soft fibre grain, curls under its own
  weight, translucent enough to catch a shadow.
- Counter: fine grain, a warm ambient occlusion pool under every object.

---

## The set

A three-quarter view of a counter, shot slightly above eye level so we look
gently down at the terminal — the angle a member of staff has when they step up
to it.

```
                     ┌──────────────────────────┐
   receipt           │                          │        card
   printer  ▸  ┌───┐ │      TILL TERMINAL       │  ◂ reader
               │≡≡≡│ │   (the login lives here) │
               └───┘ │                          │
                     └────────────┬─────────────┘
  ═════════════════════════════   │   ═══════════════════════
   ▸ belt: items travelling ▸     └── stand              bagging ▸
  ═════════════════════════════                          area
                                        cash drawer (below, closed)
```

- **The terminal** — a modern 15" tablet-style POS on an aluminium stand, tilted
  back about 12°, thin bezel, rounded corners. It is the hero and holds roughly
  two thirds of the viewport height. A customer-facing display on the reverse
  throws a faint coloured edge glow onto the counter behind it — a cheap, very
  convincing depth cue.
- **The receipt printer** — to the left, a small charcoal box with a paper slot.
  Idle, a stub of paper pokes out. This is where errors come from.
- **The card reader** — to the right on a small cradle, its own tiny screen and
  a status LED. This is the state machine made physical: dim when idle, amber
  while authorising, green on approval, red on decline.
- **The belt and bagging area** — running across the lower third, in front of
  and slightly below the terminal so it never competes with the form.
- **The cash drawer** — implied beneath the counter lip, closed. It only ever
  does one thing, once, and it is the best moment in the sequence.

### Inside the terminal screen

Laid out like a real POS, which conveniently solves the problem of where the
login goes:

```
┌────────────────────────────────────────────────────────┐
│ [LOGO SLOT]                        TILL 04 · 09:41 ● │ ← header
├──────────────────────┬─────────────────────────────────┤
│ CURRENT SALE         │        SIGN IN TO TILL          │
│                      │                                 │
│ Oat milk      £1.85  │  Email    [________________]    │
│ Sourdough     £3.20  │  Password [____________] 👁      │
│ Coffee 250g   £6.50  │  ⇪ Caps Lock is on              │
│ Bananas ×5    £1.12  │                                 │
│                      │  ┌───────────────────────────┐  │
│ ───────────────────  │  │ STAFF BADGE          ▣▣▣ │  │
│ 4 items              │  │ dan@counterpoint.co       │  │
│ TOTAL      £12.67    │  │ ▐█▌▐▌█▐█▌▐▌█▐█▌▐▌  [LOGO] │  │
│                      │  └───────────────────────────┘  │
│                      │        [    SIGN IN    ]        │
├──────────────────────┴─────────────────────────────────┤
│ F1 Recall  F2 Support  F3 Language      ⚙ Settings     │ ← function strip
└────────────────────────────────────────────────────────┘
```

The left pane keeps running the demo sale throughout. **The till carries on
working while you sign in** — that single decision is what makes the page feel
alive rather than decorated.

---

## Brand slot

The customer drops in their own identity. Three slots, one token.

| Slot | Spec | Where |
| --- | --- | --- |
| **Primary logo** | SVG, fits a 140 × 32 box, must read on white | Terminal header, left |
| **Square mark** | SVG, 1:1, min legible size 24px | Customer display, attract screen, receipt header |
| **Accent** | One hex value → `--brand` | Focus rings, active keys, function strip |

The receipt header renders the square mark **dithered to 1-bit at low
resolution** — a real thermal printer cannot do greyscale, and the halftone
version sells the illusion completely. Generate it from the same SVG at build
time or with a canvas threshold pass; do not ship a second asset.

### Example logo (placeholder)

Shipping under the name **Counterpoint** — a stand-in, clearly marked as such in
the code so it is obvious what to replace.

The mark is a receipt: a rounded rectangle with a torn zigzag bottom edge and
two short lines suggesting print. It reads at 24px, works in one colour, and
survives being dithered. Wordmark is `COUNTERPOINT` in a tight grotesque at
wide tracking, small caps weight 600.

```
   ╭─────────╮
   │ ▬▬▬▬▬   │      COUNTERPOINT
   │ ▬▬▬     │
   ╰╲╱╲╱╲╱╲╱─╯
```

Everything brand-related resolves through the three slots above, so swapping is
a one-file change with no layout consequences.

---

## Phase 0 — Idle: the open lane

Nothing is waiting for input. The lane is open and serving.

**The running sale.** Items glide in from the left on the belt: a carton of oat
milk, a sourdough loaf, coffee, bananas, a paperback, a houseplant. Each one is
a flat vector illustration — friendly, a little chunky, consistent line weight.
As an item crosses the scanner window:

1. A red fan of laser light sweeps once across it.
2. It gives a small vertical *hop* on the beep.
3. A line item flies from the item up into the sale pane and lands in the list.
4. The total rolls up on an odometer — digits tumbling, not fading.

When the basket reaches six items the sale completes: the total flashes once,
the list clears with a soft upward wipe, a short receipt prints and curls away,
and a new basket starts. Roughly a 40-second loop, and no two loops use the same
items or order.

**Cursor presence.** The terminal tilts a degree or two toward the pointer and
the specular sweep on the glass follows it, so the whole scene has parallax
without anything actually moving. Items on the belt nudge very slightly as the
cursor passes over them. The handheld scanner's beam drifts to track the cursor
when it is near.

**Attract mode.** After 60 seconds of no interaction the terminal does what real
tills do — dims to an attract screen with the logo, gently breathing. Any input
wakes it instantly.

---

## Phase 1 — Input: clocking on

Signing in is *clocking on*, and the hardware should acknowledge you arriving.

The credentials are an ordinary **email address and password** — full
alphanumeric and symbols, password managers welcome. Nothing in the theme is
allowed to make signing in stranger than it needs to be. The retail flavour goes
into what the *scene* does around a completely conventional form.

**Focusing the email field.** The sale pane politely suspends: the list slides
down a few pixels and greys back, and a small `SALE HELD` chip appears — exactly
what a till does when you interrupt a transaction. The belt keeps moving but
items now queue *before* the scanner rather than crossing it. The lane is
waiting for you.

**The staff badge assembles.** Below the two fields sits an empty badge holder.
As you type, it fills in — and this is the object the whole sequence turns on.

- **Email → the barcode.** A live barcode builds across the badge, a group of
  bars per character, drawn in the grammar of Code 128: quiet zone, start
  guard, eleven-module character cells, a check cell and a stop guard. It is a
  faithful *rendering* rather than a scannable symbol - real Code 128 needs its
  107-entry pattern table, and shipping an unverified one would be worse than
  saying so plainly. The bars are fully deterministic: the same address always
  draws the same code. As the address grows the module width narrows the way a
  real label does, floored at a legible minimum; past that the badge scrolls
  the barcode rather than shrinking it into mush. The address prints along the
  badge in monospace as you go.
- **Password → the chip.** The badge's gold chip contacts wake and a holographic
  security band starts sweeping the laminate. Deliberately *length-blind*: the
  contacts complete their cycle within the first few characters and then simply
  hold and shimmer, so the badge confirms something is being entered without
  broadcasting how long it is to anyone stood behind you. No strength meter
  either — this is a login, not a sign-up, and rating an existing password is
  both useless and faintly insulting.

By the time both fields are filled you are holding a complete, plausible staff
badge, which is exactly what Phase 2 needs.

**The system arming.** As the password fills, the peripherals wake in sequence:
the card reader's LED fades from dim to a slow amber pulse and its little screen
reads `READY`, the scanner beam narrows and steadies, the function strip's
active key picks up the brand accent. By the last keystroke the whole counter is
leaning in.

**The unglamorous parts, which matter more than the badge.** A reveal toggle on
the password. A Caps Lock warning that actually appears — with symbols in play
it is the single most common silent failure. `autocomplete="username"` and
`autocomplete="current-password"` so managers fill correctly, no `maxlength`, no
paste blocking, no per-keystroke validation nagging. Email format is checked on
submit, not while you are still typing it.

The badge is decoration built *from* the form; it is never the input. It carries
`aria-hidden`, and the form works identically with it switched off.

---

## Phase 2 — Authorising

The most familiar suspense in retail. Do not fill it with a spinner.

1. **The form hands itself over.** The sign-in panel folds away and the badge
   you assembled while typing lifts out of its holder.
2. **The barcode gets scanned.** The badge flies to the scanner glass, the laser
   fan sweeps its barcode, and it *beeps* — the same beep the demo items have
   been making for the last minute, which is exactly what makes it land.
3. **The chip gets read.** The badge slides on into the card reader, contacts
   first. The reader's screen switches to `AUTHORISING` / `DO NOT REMOVE CARD`,
   LED going solid amber.

Two beats, and they map cleanly onto the two fields: the address is the part the
shop can see, the password is the part only the chip knows.
4. **The lane holds its breath.** The belt stops mid-travel with an item halfway
   through the scanner. The lane light above turns amber and begins a slow
   rotation. Room tone ducks. The specular sweep on the glass slows to a crawl.
5. **The terminal screen** shows a full-bleed authorising state: a strip of
   receipt paper feeding steadily across as the progress indicator, monospace
   status line beneath it.

This is held for a real server round trip, floored at about two seconds so it
always reads. Everything in the scene is doing the waiting *with* you, which is
the entire point — the tension is environmental, not a widget.

---

## Phase 3a — Approved

Fast, warm, and physical. It should feel like being let in, not like a page
navigating.

- **Reader flashes green**, screen reads `APPROVED`, and the classic rising
  two-tone approval chime fires.
- **The cash drawer bangs open.** Real weight, real travel, a bell *ding* on the
  impact. A wash of warm light spills up from the drawer and rakes across the
  counter and the underside of the terminal.
- **The screen is pulled away like a receipt.** The login pane slides up and out
  of frame, and underneath it — already there, already populated — is the POS
  home screen. No load, no fade to white. The login screen *becomes* the app.
- **The held sale resumes as yours.** The basket that was running by itself is
  now the operator's opening sale. The belt restarts, the lane light returns to
  green, and the items keep coming.
- **A short receipt prints** and stays hanging: `OPERATOR SIGNED ON · DAN W ·
  TILL 04 · 09:41`. A small physical record that it happened.

---

## Phase 3b — Declined

The failure is the best part of this concept, and it belongs to the printer.

- **Reader flashes red**, screen reads `DECLINED`, two flat low buzzes. The lane
  light snaps red. The item stranded in the scanner stays stranded.
- **The screen shudders** once on impact and returns the form with the password
  cleared and focused and the email preserved — never make someone retype an
  address because they fat-fingered a symbol. The badge drops back into its
  holder with the chip dark and the barcode intact.
- **The printer runs.** A stepper-motor whirr, and the receipt feeds out in
  stuttering steps — a few millimetres per character row, not a smooth slide.
  Text appears line by line in dot-matrix monospace as the paper emerges, curls
  under its own weight, and hangs off the front of the printer.

```
      ╔══════════════════════════╗
      ║   [dithered brand mark]  ║
      ║                          ║
      ║  AUTHORISATION DECLINED  ║
      ╠══════════════════════════╣
      ║ TERMINAL      TILL 04    ║
      ║ ACCOUNT   dan@counterp…  ║
      ║ TIME          09:41:22   ║
      ╟──────────────────────────╢
      ║ REASON                   ║
      ║   INVALID CREDENTIALS    ║
      ║ ATTEMPT       1 OF 5     ║
      ╟──────────────────────────╢
      ║    PLEASE TRY AGAIN      ║
      ╚═══════╲╱╲╱╲╱╲╱╲╱╲════════╝
```

**Receipts accumulate.** A second failure prints a second receipt that pushes
the first further out and slightly askew. By the third, a small drift of curled
paper hangs off the printer. The attempt count is *physical* — you can see how
many tries you have left without reading a number.

The drift is torn off when the run of failures ends, not on any keystroke: a
decline clears the password field, so the retry always has to be typed, and
tearing on every key would mean the stack could never reach two. Changing the
email tears it off - a different name on the badge is a fresh start - and so
does signing in or signing out. Retyping the password does not: that is the
same run continuing, which is exactly when the drift should be growing.

The printed receipt is decoration. The real message goes to a live region for
screen readers at the moment of failure, and it is also readable as plain text
on the terminal screen — nobody should have to parse a picture of paper to learn
their password was wrong.

---

## Phase 3c — Supervisor lockout

After five failures the till does what a real till does: it stops trusting you.

The screen goes to a full-bleed amber `SUPERVISOR REQUIRED` state with a keyhole
graphic. The card reader goes dark. The belt stops and the lane light switches
to a slow amber blink. The final receipt prints `TERMINAL LOCKED · CALL
MANAGER · 00:30`, and the countdown ticks down on the screen in monospace.

It is an honest, in-world rate limit — and considerably more pleasant than a red
toast that says "too many attempts".

**The screen is the notice; the room is the alarm.** By the time it appears the
belt has stopped, the lane light is blinking amber, the reader has gone dark and
a receipt is hanging out of the printer. A fifth surface shouting the same word
would be a siren, so the notice does not shout: the interface goes away, and the
only thing on it that moves is a band at the edge of the glass blinking on the
lane light's own keyframe, so the screen and the lamp are visibly one machine.

**It is set to the receipt's measure.** The document is 21 characters across —
`WIDTH` in `printer.js` — so the rule rows are literally the strings the printer
prints, and the two surfaces set identically. The keyhole stands exactly where
the brand mark stands on the authorising screen, at exactly its size and drawn
in the same 1-bit dither as the printed mark: where the badge was, there is now
a lock. A reference (`LK-04-0941`) is generated once and appears on both the
screen and the paper, so the event is something an operator can quote down a
phone rather than a message that has scrolled away.

**The countdown is derived from a deadline, never decremented.** `setTimeout`
drifts and a backgrounded tab clamps it to roughly a second, so thirty
accumulated "about a second"s would still be counting long after the service had
forgotten the lock. It rounds up rather than down, so the screen never reaches
zero before the service does.

**A reload is not a way out.** `/api/health` reports whether the calling address
is currently locked and how long is left, and the offline stand-in keeps its
deadline in `sessionStorage`, so the notice comes straight back up with the time
that is actually on it — without a receipt, without the shudder, and without
stealing focus, because nothing has just been declined.

The printed receipt and the plate say the same two words, `CALL MANAGER`,
character for character. Nothing on the screen explains why: the lockout
threshold is server policy, and the operator has already watched the count climb
on four declined receipts.

---

## Details worth the effort

Small things, disproportionate payoff:

- **Live clock** in the header, correct to the second. Tills always show one and
  its absence is uncanny.
- **Odometer totals** — digits roll, never crossfade.
- **Weighed items.** Loose produce lands on the scale and the weight readout
  settles with a little overshoot before the price resolves.
- **Bagging.** Scanned items drop into a paper bag at the end of the belt and
  settle. On approval, the bag is lifted away.
- **Function strip.** `F1 Recall` doubles as *forgot password* — pressing F1 on
  the keyboard genuinely triggers it.
- **Paper stub.** The printer always has a short tongue of paper visible, so the
  first print does not appear from nowhere.
- **Customer display glow.** The reverse screen tints the counter behind the
  terminal, shifting with the state — neutral, amber, green, red.
- **Idle imperfection.** The belt has a faint seam that comes round every twelve
  seconds. Perfect loops read as fake.

---

## Sound design

Off by default, one obvious toggle, all synthesised — no audio files.

| Event | Sound |
| --- | --- |
| Item scanned | The beep. Short, ~2.7kHz, hard attack, no tail |
| Key press | Dry click, faint pitch variation per character |
| Card reader arm | Soft amber tick, once |
| Authorising | Low processing hum, slowly rising |
| Approved | Rising two-tone chime, then the drawer bell |
| Declined | Two flat low buzzes, ~180Hz |
| Printer | Stepper whirr — buzzy sawtooth bursts synced to each paper step |
| Drawer | Mechanical clunk plus bell |
| Ambient | Very quiet room tone, distant and non-committal |

The scanner beep is the anchor. Once a visitor has heard it a dozen times during
idle, using it again in Phase 2 to scan *their own* credentials does a lot of
narrative work for free.

**What was built.** The table above is a wishlist, and a page that clicks on
every keystroke and hums continuously is exhausting, so the kit leans on a fact
about the design rather than on volume: every state except `idle` and
`approved` holds the sale, so goods queue short of the scanner and the beeping
physically stops the moment anyone focuses the form. Nothing had to be faded
out to make room for the sign-in — the set already does it.

Each voice has a **place** on the counter rather than a level: a pan, an air
filter and a send into one procedurally generated room, because distance is
carried by all three together and never by level alone. The drawer is the
nearest thing and also the darkest and wettest, which is what "under the
counter" sounds like.

Two of the numbers matter more than the rest. A thermal printer's stepper feeds
0.125mm per step at 50–100mm/s, so the whirr's fundamental **is** the step rate,
400–800Hz — which is why a receipt printer sounds like a trapped hornet rather
than a motor, and why the visible stutter and the audible buzz are the same
event. And the beep is a **square** wave with a **flat top**, not a sine with an
envelope: a piezo is driven by a rectangular gate, and a sine at 2.7kHz is a
hearing test.

Under `authorising` the room and the belt duck away and the terminal's own
supply is left exposed with a fan rising over it — the machine straining, not a
spaceship. Under `locked` every bed fades and there is one sound at each end of
the thirty seconds; the room returning **is** the unlock.

The balance was set by rendering each voice into an `OfflineAudioContext` and
measuring it, not by ear, which caught three things listening might not have:
an ambient bed twenty decibels louder than intended that masked half the kit, a
gate that suppressed every sound for the first ninety milliseconds of a
context's life, and gain nodes whose envelopes started *after* their sources, so
a keystroke fired four milliseconds of full-scale sine and the drawer a tenth of
a second of full-scale noise.

`prefers-reduced-motion` is **not** treated as a mute: it is a vestibular
signal, it says nothing about audio, and off-by-default already gives everyone
the strongest guarantee there is. It is honoured as a choreography constraint
instead — the reduced-motion path skips the belt entirely, so the scan is
announced from the static list, and the badge beep is fired directly because
the flight does not happen. Sound with no motion is a supported configuration.

---

## Accessibility and reduced motion

A light theme means contrast is entirely our responsibility, and a busy
background makes it harder. Rules:

- All body text meets **WCAG AA**, all status messaging targets **AAA**. Any
  message over a moving or textured surface gets its own opaque plate — the
  same lesson as the previous project.
- The terminal screen UI is a genuine form: labels, DOM order, focus rings on
  the brand accent, visible at all times.
- The form is an ordinary email + password pair. Password managers, autofill,
  paste and browser validation all work untouched; the badge is `aria-hidden`
  decoration rendered *from* the fields and never a substitute for them.
- Caps Lock is surfaced prominently — with symbols in play it is the most common
  cause of a failed sign-in, and the receipt should not be the first hint.
- Failure is announced through `role="status"` in text, independent of the
  printed receipt.
- Caps Lock, attempt count, and lockout countdown are all announced.

**`prefers-reduced-motion`,** honoured and runtime-toggleable:

- Belt slows dramatically and items cross-fade rather than travel; scanning
  still beeps and still totals.
- No terminal tilt, no parallax, no screen shudder.
- The receipt presents fully formed instead of stuttering out, still with its
  ink-bleed styling.
- The drawer opens without the light rake; the app cross-fades in.

The sequence never depends on animation to convey state — colour, text and the
reader's status word always say the same thing the motion does.

---

## Responsive behaviour

- **Desktop (≥1200px):** the full set — counter, belt, printer, reader, drawer.
- **Laptop (≥900px):** counter tightens, belt shortens, peripherals move closer.
- **Tablet (≥600px):** the terminal becomes the frame. Printer stays (the
  receipt is essential); belt reduces to a strip behind the terminal.
- **Mobile:** the terminal screen goes near full-bleed and the set falls away to
  a suggestion of counter at the edges. The sale pane collapses to a summary
  bar; the form takes the full width. The receipt slides up from the bottom
  edge rather than out of a printer.

The login must be completable at every size with no horizontal scrolling and no
reliance on the scene being visible.

---

## Technical approach

Deliberately different from the previous project, because the constraints are
different. That one was a particle field where nothing needed to be crisp text.
This one is full of small type on a light background, and text crispness and
accessibility matter far more than raw particle count.

- **DOM, CSS and SVG do the work.** CSS 3D transforms for the terminal and
  perspective, SVG for items, logo, badge, barcode and laser, DOM for everything
  with words in it. Real text, real focus, real semantics.
- **Canvas only where it earns it** — paper grain, the dithered logo pass, and
  the soft light rake from the drawer.
- **The scene is a state machine**, same discipline as before: one table of
  states (`idle`, `held`, `entering`, `authorising`, `approved`, `declined`,
  `locked`), each with its own values for lane light, reader LED, belt speed,
  ambient level. Every peripheral reads from it. No component decides its own
  state locally.
- **Choreography runs on timers, not frame delivery** — the previous build hung
  when a background tab starved `requestAnimationFrame`, and the same shape of
  bug is available here.
- **No frameworks, no build step**, consistent with the last one. Vanilla ES
  modules.
- **Backend:** reuse the shape of the existing Node auth service — a real round
  trip, padded to a randomised window, identical timing for hits and misses,
  lockout after five attempts feeding Phase 3c. Docker Compose with nginx in
  front.

---

## Build order

Each step is independently reviewable and leaves something demonstrable.

| Step | Deliverable | Depends on |
| --- | --- | --- |
| **1. The set** | Static scene: counter, terminal, printer, reader, correct lighting and materials. No motion. | — |
| **2. Screen UI** | The POS layout inside the terminal — header with logo slot, sale pane, form pane, function strip. Fully accessible, fully static. | 1 |
| **3. The lane** | Belt, items, scanner sweep, line items flying to the list, odometer total, basket loop. **This is Phase 0 complete.** | 2 |
| **4. State machine** | Central state table driving lane light, reader LED, belt speed, glow. Switchable by hand for testing. | 3 |
| **5. Input choreography** | Sale-held behaviour, badge assembly (Code 128 barcode + chip), reveal toggle, Caps Lock, arming sequence. **Phase 1 complete.** | 4 |
| **6. Auth service** | Node endpoint, padded timing, attempt counting, lockout. Wired to the form. | 2 |
| **7. Authorising** | Badge hand-off — scan then chip read — reader takeover, belt halt, screen state. **Phase 2 complete.** | 5, 6 |
| **8. Approved** | Drawer, light rake, screen pull-away, POS home screen underneath. **Phase 3a complete.** | 7 |
| **9. Declined** | Printer mechanics, stuttered receipt, ink-bleed type, accumulating stack, live region. **Phase 3b complete.** | 7 |
| **10. Lockout** | Supervisor state and countdown. **Phase 3c complete.** | 9 |
| **11. Sound** | Full synthesised kit behind the toggle. | 8, 9 |
| **12. Polish** | Reduced motion, responsive tiers, attract mode, contrast audit, brand-swap check with a hostile accent colour. | all |

Steps 1–3 alone produce something worth showing: a bright, alive till that
already sells the concept before a single credential is typed.

---

## Decisions to confirm

1. **Brand.** `Counterpoint` and `#4356E0` are placeholders. Real name, mark and
   accent whenever available; the swap is one file either way.
2. **Item set.** Generic groceries are the safe default. If they sell into a
   specific vertical — hospitality, salons, garden centres — the belt should
   carry that vertical's goods instead, and it costs nothing to change.
3. **Reuse the stack?** The nginx + Node + Compose arrangement from the previous
   project transfers directly. Assuming yes unless told otherwise.
4. **How far does "the app" go?** Phase 3a needs a POS home screen underneath to
   pull away to. Currently scoped as a convincing shell, not a working till.
