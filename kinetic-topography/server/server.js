'use strict';
/**
 * Auth service for The Kinetic Topography.
 *
 * Zero dependencies on purpose - `node server.js` is the whole thing.
 * The only unusual behaviour is deliberate: every verification is padded to a
 * randomised delay so the client's Phase 2 (the gyroscope) always has a real
 * server round-trip to sit inside. The tension is not faked on the client.
 */
const http = require('http');
const crypto = require('crypto');

const PORT = Number(process.env.PORT || 8080);
const MIN_DELAY = Number(process.env.AUTH_MIN_DELAY_MS || 1500);
const MAX_DELAY = Number(process.env.AUTH_MAX_DELAY_MS || 2400);

// Demo directory. Passwords are stored as salted SHA-256 so the plaintext is
// not sitting in the file; the pairs are printed in the README anyway.
const salt = 'kinetic-topography';
const digest = (s) => crypto.createHash('sha256').update(salt + ':' + s).digest('hex');
const USERS = new Map([
  ['operator', { hash: digest('topography'), name: 'Operator', role: 'Systems' }],
  ['dan',      { hash: digest('kinetic'),    name: 'Dan',      role: 'Owner'   }],
  ['demo',     { hash: digest('demo1234'),   name: 'Demo',     role: 'Guest'   }],
]);

const attempts = new Map(); // ip -> { n, until }
const LOCK_AFTER = 6;
const LOCK_MS = 30_000;

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
    return send(res, 200, { ok: true, service: 'kt-auth', uptime: Math.round(process.uptime()) });
  }

  if (url.pathname === '/api/login' && req.method === 'POST') {
    const ip = req.headers['x-real-ip'] || req.socket.remoteAddress || 'unknown';
    const started = Date.now();
    const lock = attempts.get(ip);

    if (lock && lock.until > started) {
      await wait(jitter() * 0.6);
      return send(res, 429, {
        ok: false,
        code: 'locked',
        message: `Too many attempts. Cooling down for ${Math.ceil((lock.until - started) / 1000)}s.`,
      });
    }

    let body;
    try { body = await readJson(req); }
    catch (err) { return send(res, 400, { ok: false, code: 'bad_request', message: err.message }); }

    const username = String(body.username || '').trim().toLowerCase();
    const password = String(body.password || '');
    const record = USERS.get(username);
    const ok = Boolean(record) && constantTimeEqual(record.hash, digest(password));

    // Pad to the tension window regardless of outcome - identical timing for
    // hits and misses, which is both good practice and good choreography.
    const elapsed = Date.now() - started;
    await wait(Math.max(0, jitter() - elapsed));

    if (!ok) {
      const next = { n: (lock?.n || 0) + 1, until: 0 };
      if (next.n >= LOCK_AFTER) { next.until = Date.now() + LOCK_MS; next.n = 0; }
      attempts.set(ip, next);
      return send(res, 401, {
        ok: false,
        code: 'invalid_credentials',
        message: 'Signature rejected. Check your credentials.',
      });
    }

    attempts.delete(ip);
    return send(res, 200, {
      ok: true,
      token: crypto.randomBytes(24).toString('base64url'),
      user: { id: username, name: record.name, role: record.role },
      issuedAt: new Date().toISOString(),
    });
  }

  send(res, 404, { ok: false, code: 'not_found', message: 'No such endpoint.' });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[kt-auth] listening on :${PORT}  (delay window ${MIN_DELAY}-${MAX_DELAY}ms)`);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => server.close(() => process.exit(0)));
}
