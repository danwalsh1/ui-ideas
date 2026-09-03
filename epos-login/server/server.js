'use strict';
/**
 * Auth service for The Open Lane.
 *
 * Zero dependencies on purpose - `node server.js` is the whole thing.
 *
 * The one unusual behaviour is deliberate: every verification is padded to a
 * randomised window so the authorising phase always wraps a real round trip.
 * The pause is the point of the design, not something to optimise away, and
 * padding it identically for hits and misses is also the correct thing to do
 * - response time must not tell an attacker whether an account exists.
 */
const http = require('http');
const crypto = require('crypto');

const PORT = Number(process.env.PORT || 8080);
const MIN_DELAY = Number(process.env.AUTH_MIN_DELAY_MS || 1500);
const MAX_DELAY = Number(process.env.AUTH_MAX_DELAY_MS || 2400);
const LOCK_AFTER = Number(process.env.AUTH_LOCK_AFTER || 5);
const LOCK_MS = Number(process.env.AUTH_LOCK_MS || 30_000);

// Demo directory. Passwords are stored as salted SHA-256 so the plaintext is
// not sitting in the file; the pairs are in the README either way.
const SALT = 'the-open-lane';
const digest = (s) => crypto.createHash('sha256').update(`${SALT}:${s}`).digest('hex');

const USERS = new Map([
  ['dan@counterpoint.co', { hash: digest('openlane'), name: 'Dan Walsh', role: 'Manager' }],
  ['operator@counterpoint.co', { hash: digest('till04'), name: 'Sam Okafor', role: 'Operator' }],
  ['demo@counterpoint.co', { hash: digest('demo1234'), name: 'Demo User', role: 'Trainee' }],
]);

/** ip -> { fails, until } */
const attempts = new Map();

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const jitter = () => MIN_DELAY + Math.random() * Math.max(0, MAX_DELAY - MIN_DELAY);

function send(res, code, body) {
  const payload = JSON.stringify(body);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'content-type',
    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
  });
  res.end(payload);
}

function readJson(req, limit = 8192) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('payload too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); }
      catch { reject(new Error('malformed json')); }
    });
    req.on('error', reject);
  });
}

function constantTimeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');

  if (req.method === 'OPTIONS') return send(res, 204, {});

  if (url.pathname === '/api/health') {
    return send(res, 200, {
      ok: true,
      service: 'openlane-auth',
      uptime: Math.round(process.uptime()),
      lockAfter: LOCK_AFTER,
    });
  }

  if (url.pathname === '/api/login' && req.method === 'POST') {
    const ip = req.headers['x-real-ip'] || req.socket.remoteAddress || 'unknown';
    const started = Date.now();
    const record = attempts.get(ip);

    // Already locked out. Still padded, so the lock cannot be probed for
    // timing either.
    if (record && record.until > started) {
      await wait(jitter() * 0.6);
      return send(res, 429, {
        ok: false,
        code: 'locked',
        retryAfter: Math.ceil((record.until - started) / 1000),
        message: 'Terminal locked. A supervisor must unlock this till.',
      });
    }

    let body;
    try { body = await readJson(req); }
    catch (err) { return send(res, 400, { ok: false, code: 'bad_request', message: err.message }); }

    const email = String(body.email || '').trim().toLowerCase();
    const password = String(body.password || '');
    const user = USERS.get(email);
    // Hash unconditionally. Short-circuiting on a missing user would skip the
    // digest and make unknown accounts measurably cheaper to answer - the
    // padding hides it, but the asymmetry costs nothing to remove at source.
    const supplied = digest(password);
    const ok = Boolean(user) && constantTimeEqual(user.hash, supplied);

    // Pad to the authorising window regardless of outcome.
    await wait(Math.max(0, jitter() - (Date.now() - started)));

    if (!ok) {
      const fails = (record?.fails || 0) + 1;
      if (fails >= LOCK_AFTER) {
        attempts.set(ip, { fails: 0, until: Date.now() + LOCK_MS });
        return send(res, 429, {
          ok: false,
          code: 'locked',
          retryAfter: Math.ceil(LOCK_MS / 1000),
          message: 'Terminal locked. A supervisor must unlock this till.',
        });
      }
      attempts.set(ip, { fails, until: 0 });
      return send(res, 401, {
        ok: false,
        code: 'invalid_credentials',
        attempt: fails,
        of: LOCK_AFTER,
        message: 'Authorisation declined. Check your email and password.',
      });
    }

    attempts.delete(ip);
    return send(res, 200, {
      ok: true,
      token: crypto.randomBytes(24).toString('base64url'),
      user: { id: email, name: user.name, role: user.role },
      issuedAt: new Date().toISOString(),
    });
  }

  send(res, 404, { ok: false, code: 'not_found', message: 'No such endpoint.' });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[openlane-auth] :${PORT}  delay ${MIN_DELAY}-${MAX_DELAY}ms  lock after ${LOCK_AFTER}`);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => server.close(() => process.exit(0)));
}
