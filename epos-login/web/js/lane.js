// The lane: goods travel the belt, cross the scanner, and land in the sale.
//
// This is Phase 0 - the ambient life of the page. It runs on its own and
// never blocks or interferes with signing in. Step 4 will drive belt speed
// and pausing from the central state machine; the hooks are already here.

const money = (pence) => '£' + (pence / 100).toFixed(2);

// `k` scales each item against the shared item unit so a loaf reads bigger
// than a milk carton without hand-sizing every sprite.
const CATALOGUE = [
  { id: 'milk',   name: 'Oat milk 1L',       price: 185, k: 0.80 },
  { id: 'bread',  name: 'Sourdough loaf',    price: 320, k: 1.05 },
  { id: 'coffee', name: 'Coffee beans 250g', price: 650, k: 0.86 },
  { id: 'banana', name: 'Bananas',           price: 112, k: 1.22, qty: 5 },
  { id: 'book',   name: 'Paperback',         price: 899, k: 0.84 },
  { id: 'plant',  name: 'Herb pot',          price: 450, k: 1.12 },
];

const SPEED = 132;        // px per second along the belt
const SPAWN_GAP = 4.1;    // seconds between goods
const RIB_PERIOD = 26;    // must match the ribs gradient in lane.css
const SEAM_EVERY = 12;    // seconds between belt seams
const SETTLE = 3.6;       // pause after the last scan before the sale closes
const QUEUE_GAP = 26;     // clear space kept between goods on the belt
const HOLD_BACK = 24;     // how far short of the scanner a held queue stops

function shuffled(list) {
  const a = [...list];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/* ------------------------------------------------------------------ *
 * Odometer
 * Digits roll rather than crossfade. Every cell is exactly 1em tall and
 * the row is bottom-aligned, so the pound sign and point sit on the same
 * baseline as the rolling digits.
 * ------------------------------------------------------------------ */
function setOdometer(host, text) {
  const shape = text.replace(/\d/g, '#');
  if (host.dataset.shape !== shape) {
    // The digit count changed (crossing £10, or resetting). Rebuild.
    host.dataset.shape = shape;
    host.textContent = '';
    const row = document.createElement('span');
    row.className = 'od-row';
    for (const ch of text) {
      const cell = document.createElement('span');
      cell.className = 'od-cell';
      const strip = document.createElement('span');
      strip.className = 'od-strip';
      if (ch >= '0' && ch <= '9') {
        for (let d = 0; d < 10; d++) {
          const s = document.createElement('span');
          s.textContent = String(d);
          strip.appendChild(s);
        }
        cell.dataset.digit = '';
      } else {
        const s = document.createElement('span');
        s.textContent = ch;
        strip.appendChild(s);
      }
      cell.appendChild(strip);
      row.appendChild(cell);
    }
    host.appendChild(row);
  }
  const cells = host.querySelectorAll('.od-cell');
  [...text].forEach((ch, i) => {
    const cell = cells[i];
    if (!cell || cell.dataset.digit === undefined) return;
    cell.firstChild.style.transform = `translateY(-${Number(ch)}em)`;
  });
}

/* ------------------------------------------------------------------ */
export class Lane {
  constructor() {
    this.belt = document.querySelector('.lane-belt');
    this.ribs = document.querySelector('.belt__ribs');
    this.seam = document.querySelector('.belt__seam');
    this.itemsEl = document.querySelector('.belt__items');
    this.scanner = document.querySelector('.scanner');
    this.bag = document.querySelector('.bag');

    this.list = document.querySelector('.sale__list');
    this.count = document.querySelector('.sale__count');
    this.total = document.querySelector('.sale__total strong');

    this.items = [];
    this.basket = [];
    this.spawnIndex = 0;
    this.scannedCount = 0;
    this.totalPence = 0;
    this.spawnTimer = 0;
    this.settleTimer = 0;
    this.travelled = 0;
    this.speed = SPEED;
    this.speedTarget = SPEED;
    // Bumped whenever the sale resets. A line in flight when the sale closes
    // belongs to the sale that scanned it, not to the one that follows.
    this.saleId = 0;
    // When held, goods run up to the scanner and wait rather than crossing
    // it. The lane keeps feeding; it just stops serving.
    this.hold = false;
    this.running = false;
    this.reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    this._measure();
    window.addEventListener('resize', () => this._measure(), { passive: true });
  }

  /* ---- geometry -------------------------------------------------- */
  _measure() {
    if (!this.belt) return;
    const b = this.belt.getBoundingClientRect();
    this.width = b.width;
    const s = this.scanner.getBoundingClientRect();
    this.scanX = s.left + s.width / 2 - b.left;
    this.holdX = this.scanX - s.width / 2 - HOLD_BACK;
    const g = this.bag.getBoundingClientRect();
    this.bagX = g.left - b.left;
  }

  /* ---- lifecycle -------------------------------------------------- */
  start() {
    if (!this.list) return;
    this._newBasket();
    this._resetSale();

    if (this.reduced) { this._startStatic(); return; }
    if (!this.belt) return;

    this.running = true;
    let last = performance.now();
    const loop = (now) => {
      if (!this.running) return;
      const dt = Math.min((now - last) / 1000, 0.05);
      last = now;
      this._frame(dt);
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }

  /** The stage drives these. 1 is the open lane, 0 halts the belt. */
  setSpeedScale(k) { this.speedTarget = SPEED * Math.max(0, k); }
  setHold(on) { this.hold = Boolean(on); }
  pause() { this.running = false; }

  /* ---- the frame -------------------------------------------------- */
  _frame(dt) {
    // Ease toward the target so a state change reads as the belt slowing
    // rather than a cut. Fast enough that a halt still feels decisive.
    this.speed += (this.speedTarget - this.speed) * (1 - Math.exp(-5.5 * dt));
    const halted = this.speed < 2;

    const move = this.speed * dt;
    this.travelled += move;

    // Belt surface and its seam travel with the goods.
    this.ribs.style.backgroundPositionX = (this.travelled % RIB_PERIOD) + 'px';
    const seamCycle = this.speed * SEAM_EVERY;
    this.seam.style.transform =
      `translateX(${(this.travelled % seamCycle) - 30}px)`;

    // Spawn the next item in the basket. Never while the belt is stopped -
    // goods would pile up unseen at the head of the lane.
    if (!halted && this.spawnIndex < this.basket.length) {
      this.spawnTimer -= dt;
      if (this.spawnTimer <= 0) {
        this._spawn();
        this.spawnTimer = SPAWN_GAP;
      }
    }

    // Forward pass, oldest first. Each item is capped by the one ahead of
    // it, so goods never overlap, and by the hold line when the sale is
    // suspended - which is what makes them queue instead of crossing.
    let limit = this.hold ? this.holdX : Infinity;
    for (const it of this.items) {
      const w = it.el.offsetWidth;
      it.x = Math.min(it.x + move, limit - w);
      it.el.style.transform = `translate3d(${it.x}px,0,0)`;
      limit = Math.min(limit, it.x - QUEUE_GAP);

      const centre = it.x + w / 2;
      if (!it.scanned && centre >= this.scanX) this._scan(it);
      if (!it.bagging && centre >= this.bagX) {
        it.bagging = true;
        it.el.classList.add('is-bagging');
      }
    }

    for (let i = this.items.length - 1; i >= 0; i--) {
      if (this.items[i].x > this.width + 160) {
        this.items[i].el.remove();
        this.items.splice(i, 1);
      }
    }

    // Close the sale a beat after the last item is scanned. A halted lane
    // holds the sale open: nothing completes while the till is thinking.
    if (!halted && this.scannedCount >= this.basket.length && this.basket.length) {
      this.settleTimer += dt;
      if (this.settleTimer >= SETTLE) this._closeSale();
    }
  }

  /* ---- events ----------------------------------------------------- */
  _spawn() {
    const entry = this.basket[this.spawnIndex++];
    const el = document.createElement('div');
    el.className = 'item';
    el.style.setProperty('--k', entry.k);
    el.innerHTML = `<svg viewBox="0 0 64 84" aria-hidden="true"><use href="#it-${entry.id}"/></svg>`;
    this.itemsEl.appendChild(el);
    this.items.push({ el, entry, x: -140, scanned: false, bagging: false });
  }

  _scan(it) {
    it.scanned = true;
    this.scannedCount++;

    this.scanner.classList.remove('is-reading');
    void this.scanner.offsetWidth;          // restart the beam animation
    this.scanner.classList.add('is-reading');
    setTimeout(() => this.scanner.classList.remove('is-reading'), 260);

    it.el.classList.add('is-scanned');
    this._fly(it.el, it.entry);
  }

  /** Carry the line up into the sale pane, then hand off to a real row. */
  _fly(fromEl, entry) {
    const saleId = this.saleId;
    const from = fromEl.getBoundingClientRect();
    const list = this.list.getBoundingClientRect();

    const flyer = document.createElement('div');
    flyer.className = 'flyer';
    flyer.innerHTML = `<span></span><b></b>`;
    flyer.firstChild.textContent = entry.name;
    flyer.lastChild.textContent = money(entry.price);
    document.body.appendChild(flyer);

    const rowH = this.list.firstElementChild
      ? this.list.firstElementChild.offsetHeight + 6
      : 22;
    const x0 = from.left + from.width / 2 - flyer.offsetWidth / 2;
    const y0 = from.top + from.height * 0.2;
    const x1 = list.left;
    const y1 = list.top + this.list.children.length * rowH;

    flyer.animate([
      { transform: `translate(${x0}px,${y0}px) scale(.86)`, opacity: 0 },
      { transform: `translate(${(x0 + x1) / 2}px,${Math.min(y0, y1) - 54}px) scale(1)`,
        opacity: 1, offset: 0.42 },
      { transform: `translate(${x1}px,${y1}px) scale(.8)`, opacity: 0 },
    ], { duration: 720, easing: 'cubic-bezier(.32,.72,.3,1)' })
      .finished.then(() => {
        flyer.remove();
        if (saleId === this.saleId) this._addRow(entry);
      })
      .catch(() => flyer.remove());
  }

  _addRow(entry) {
    const li = document.createElement('li');
    const name = document.createElement('span');
    name.className = 'sale__name';
    name.textContent = entry.name;
    if (entry.qty) {
      const q = document.createElement('span');
      q.className = 'sale__qty';
      q.textContent = ` ×${entry.qty}`;
      name.appendChild(q);
    }
    const price = document.createElement('span');
    price.className = 'sale__price';
    price.textContent = money(entry.price);
    li.append(name, price);
    li.classList.add('is-landing');
    this.list.appendChild(li);

    this.totalPence += entry.price;
    this._paintTotals();
  }

  _paintTotals() {
    const n = this.list.children.length;
    this.count.textContent = n === 1 ? '1 item' : `${n} items`;
    setOdometer(this.total, money(this.totalPence));
  }

  _resetSale() {
    this.saleId++;
    this.list.textContent = '';
    this.totalPence = 0;
    this._paintTotals();
  }

  _newBasket() {
    this.basket = shuffled(CATALOGUE).slice(0, 4 + Math.floor(Math.random() * 3));
    this.spawnIndex = 0;
    this.scannedCount = 0;
    this.settleTimer = 0;
    this.spawnTimer = 0.6;
  }

  _closeSale() {
    this.settleTimer = -999;                 // guard against re-entry
    this.total.parentElement.classList.add('is-settled');

    setTimeout(() => {
      this.list.classList.add('is-clearing');
      setTimeout(() => {
        this.list.classList.remove('is-clearing');
        this.total.parentElement.classList.remove('is-settled');
        this._resetSale();
        this._newBasket();
      }, 420);
    }, 900);
  }

  /* ---- reduced motion --------------------------------------------- *
     Nothing travels and nothing rolls, but the till still works through
     a basket so the page is not simply frozen. */
  _startStatic() {
    const tick = () => {
      if (this.spawnIndex < this.basket.length) {
        this._addRow(this.basket[this.spawnIndex++]);
        setTimeout(tick, 4200);
      } else {
        setTimeout(() => {
          this._resetSale();
          this._newBasket();
          setTimeout(tick, 1200);
        }, 5000);
      }
    };
    setTimeout(tick, 900);
  }
}
