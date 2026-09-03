// Auth client.
//
// Talks to the Node service behind nginx. If that is not reachable - the page
// opened straight off disk, or the api container is down - it falls back to a
// stand-in with the same timing, the same attempt counting and the same lock,
// so the whole sequence can always be seen and reviewed.

const LOCK_AFTER = 5;
const LOCK_MS = 30_000;

const OFFLINE_USERS = new Map([
  ['dan@counterpoint.co', { password: 'openlane', name: 'Dan Walsh', role: 'Manager' }],
  ['operator@counterpoint.co', { password: 'till04', name: 'Sam Okafor', role: 'Operator' }],
  ['demo@counterpoint.co', { password: 'demo1234', name: 'Demo User', role: 'Trainee' }],
]);

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// `locked` and `retryAfter` are filled in by probe() so the page can come up
// already locked after a reload. Without that the till would look ready while
// the service still refuses, and the only way to discover the lock would be to
// spend another attempt on it.
export const state = { offline: false, checked: false, locked: false, retryAfter: 0 };

let offlineFails = 0;
let offlineUntil = 0;

// The stand-in keeps its lock in sessionStorage for the same reason the service
// reports one: a reload must not be a way out of it. Per-tab, and gone when the
// tab is, which is the right lifetime for a demo lock.
const LOCK_KEY = 'openlane.lock';
try {
  const saved = Number(sessionStorage.getItem(LOCK_KEY));
  if (saved > Date.now()) offlineUntil = saved;
} catch { /* storage can be denied; the lock is simply not restored */ }

function rememberOfflineLock(until) {
  offlineUntil = until;
  try { sessionStorage.setItem(LOCK_KEY, String(until)); }
  catch { /* nothing to do; the in-memory lock still holds for this page */ }
}

const secondsLeft = (until) => Math.max(0, Math.ceil((until - Date.now()) / 1000));

export async function probe() {
  try {
    const res = await fetch('/api/health', { cache: 'no-store' });
    state.offline = !res.ok;
    if (!state.offline) {
      const body = await res.json().catch(() => ({}));
      state.locked = Boolean(body.locked);
      state.retryAfter = Number(body.retryAfter) || 0;
    }
  } catch {
    state.offline = true;
  }
  if (state.offline) {
    state.retryAfter = secondsLeft(offlineUntil);
    state.locked = state.retryAfter > 0;
  }
  state.checked = true;
  return !state.offline;
}

async function offlineLogin(email, password) {
  const now = Date.now();
  if (offlineUntil > now) {
    await wait(900 + Math.random() * 500);
    return {
      ok: false,
      code: 'locked',
      retryAfter: secondsLeft(offlineUntil),
      message: 'Terminal locked. A supervisor must unlock this till.',
    };
  }

  await wait(1500 + Math.random() * 900);

  const user = OFFLINE_USERS.get(String(email).trim().toLowerCase());
  if (!user || user.password !== password) {
    offlineFails += 1;
    if (offlineFails >= LOCK_AFTER) {
      offlineFails = 0;
      rememberOfflineLock(Date.now() + LOCK_MS);
      return {
        ok: false,
        code: 'locked',
        retryAfter: Math.ceil(LOCK_MS / 1000),
        message: 'Terminal locked. A supervisor must unlock this till.',
      };
    }
    return {
      ok: false,
      code: 'invalid_credentials',
      attempt: offlineFails,
      of: LOCK_AFTER,
      message: 'Authorisation declined. Check your email and password.',
    };
  }

  offlineFails = 0;
  try { sessionStorage.removeItem(LOCK_KEY); } catch { /* never mind */ }
  return {
    ok: true,
    token: 'offline-' + Math.random().toString(36).slice(2, 18),
    user: { id: email, name: user.name, role: user.role },
    issuedAt: new Date().toISOString(),
  };
}

export async function login(email, password) {
  if (state.offline) return offlineLogin(email, password);
  try {
    const res = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
      cache: 'no-store',
    });
    const body = await res.json().catch(() => ({}));
    if (res.ok && body.ok) return body;
    return {
      ok: false,
      code: body.code || 'error',
      attempt: body.attempt,
      of: body.of,
      retryAfter: body.retryAfter,
      message: body.message || `Request failed (${res.status}).`,
    };
  } catch {
    // The service went away mid-session: degrade rather than dead-end.
    state.offline = true;
    return offlineLogin(email, password);
  }
}
