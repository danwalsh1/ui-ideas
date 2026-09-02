// Auth client. Talks to the Node service behind nginx; if that is not
// reachable (opened without the stack running) it falls back to an offline
// stand-in with the same timing, so the choreography can always be seen.

const OFFLINE_USERS = new Map([
  ['operator', { password: 'topography', name: 'Operator', role: 'Systems' }],
  ['dan', { password: 'kinetic', name: 'Dan', role: 'Owner' }],
  ['demo', { password: 'demo1234', name: 'Demo', role: 'Guest' }],
]);

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

export const state = { offline: false };

export async function probe() {
  try {
    const res = await fetch('/api/health', { cache: 'no-store' });
    state.offline = !res.ok;
  } catch {
    state.offline = true;
  }
  return !state.offline;
}

async function offlineLogin(username, password) {
  await wait(1500 + Math.random() * 900);
  const rec = OFFLINE_USERS.get(String(username).trim().toLowerCase());
  if (!rec || rec.password !== password) {
    return { ok: false, code: 'invalid_credentials', message: 'Signature rejected. Check your credentials.' };
  }
  return {
    ok: true,
    token: 'offline-' + Math.random().toString(36).slice(2),
    user: { id: username, name: rec.name, role: rec.role },
    issuedAt: new Date().toISOString(),
  };
}

export async function login(username, password) {
  if (state.offline) return offlineLogin(username, password);
  try {
    const res = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
      cache: 'no-store',
    });
    const body = await res.json().catch(() => ({}));
    if (res.ok && body.ok) return body;
    return {
      ok: false,
      code: body.code || 'error',
      message: body.message || `Request failed (${res.status}).`,
    };
  } catch {
    // The service went away mid-session: degrade rather than dead-end.
    state.offline = true;
    return offlineLogin(username, password);
  }
}
