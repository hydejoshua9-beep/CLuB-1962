'use strict';
const path = require('node:path');
const crypto = require('node:crypto');
const express = require('express');
const A = require('./auth');

/* ---------- helpers ---------- */
const COLS = ['sales', 'inventory', 'expenses', 'marketing', 'customers', 'suppliers', 'plans', 'ideas'];
const ID_RE = /^[A-Za-z0-9_.:@+~-]{1,80}$/;
const MAX_DOC = 32 * 1024;
const newId = pre => pre + Date.now().toString(36) + crypto.randomBytes(3).toString('hex');
const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Jamaica', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());

class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
const bad = msg => new HttpError(400, msg);
const str = (v, max = 200) => String(v == null ? '' : v).trim().slice(0, max);
const mapUser = r => ({ id: r.id, username: r.username, name: r.name, role: r.role, active: !!r.active, createdAt: r.created_at });

function checkDoc(col, id, data) {
  if (!COLS.includes(col)) throw new HttpError(404, 'Unknown section.');
  if (!ID_RE.test(String(id || ''))) throw bad('That record ID isn’t valid.');
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw bad('The record is empty.');
  const body = Object.assign({}, data); delete body.id;
  const json = JSON.stringify(body);
  if (json.length > MAX_DOC) throw bad('That record is too large.');
  return json;
}
const upsert = (t, col, id, json, by) => t.run(
  'INSERT INTO docs(col,id,data,updated_at,updated_by) VALUES(?,?,?,?,?) ON CONFLICT(col,id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at, updated_by = excluded.updated_by',
  [col, id, json, Date.now(), by]);

/* ---------- first owner account ---------- */
async function seed(db, log = console.log) {
  const users = await db.get('SELECT COUNT(*) AS n FROM users');
  if (Number(users.n) === 0) {
    const username = str(process.env.OWNER_USERNAME || 'owner', 40).toLowerCase();
    let password = process.env.OWNER_PASSWORD;
    const generated = !password;
    if (generated) password = crypto.randomBytes(9).toString('base64url');
    await db.run('INSERT INTO users(id,username,name,role,password_hash,active,created_at) VALUES(?,?,?,?,?,?,?)',
      [newId('u'), username, str(process.env.OWNER_NAME || 'Owner', 80), 'owner', A.hashPassword(password), 1, Date.now()]);
    log('Created owner account "' + username + '".' + (generated ? ' Temporary password: ' + password + '  (sign in and change it under Account)' : ''));
  }
}

/* ---------- live updates (Server-Sent Events) ---------- */
function makeHub() {
  const clients = new Set();
  let version = Date.now();
  setInterval(() => { for (const res of clients) res.write(': ping\n\n'); }, 25000).unref();
  return {
    add(res) { clients.add(res); res.on('close', () => clients.delete(res)); },
    bump(by) { version++; const msg = 'event: change\ndata: ' + JSON.stringify({ v: version, by }) + '\n\n'; for (const res of clients) res.write(msg); },
    get version() { return version; }
  };
}

/* ---------- app ---------- */
function createApp(db, opts = {}) {
  const app = express();
  const hub = makeHub();
  app.set('trust proxy', 1);
  app.disable('x-powered-by');

  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    // cdnjs serves the Excel exporter, loaded only when someone taps Export to Excel.
    res.setHeader('Content-Security-Policy',
      "default-src 'self'; script-src 'self' https://cdnjs.cloudflare.com; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data: blob:; connect-src 'self'; manifest-src 'self'; worker-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    if (req.secure) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
    next();
  });

  // Health checks from the host arrive over plain http, so answer them before the https redirect.
  app.get('/healthz', (req, res) => res.send('ok'));

  if (opts.forceHttps) {
    app.use((req, res, next) => {
      if (req.secure || req.hostname === 'localhost' || req.hostname === '127.0.0.1') return next();
      res.redirect(301, 'https://' + req.headers.host + req.originalUrl);
    });
  }

  const api = express.Router();
  api.use(express.json({ limit: '3mb' }));
  api.use((req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });
  api.use(A.sessionMiddleware(db));
  // CSRF guard: browsers only send this custom header from our own pages.
  api.use((req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD' && req.get('X-Requested-With') !== 'fetch') return next(new HttpError(403, 'Request blocked.'));
    next();
  });

  const h = fn => (req, res, next) => Promise.resolve(fn(req, res)).catch(next);
  const auth = (req, res, next) => (req.user ? next() : next(new HttpError(401, 'Please sign in.')));
  const owner = (req, res, next) => (!req.user ? next(new HttpError(401, 'Please sign in.')) : req.user.role === 'owner' ? next() : next(new HttpError(403, 'Only the owner can do that.')));
  const changed = req => hub.bump(req.user && req.user.name);

  /* ----- sign in ----- */
  api.post('/login', h(async (req, res) => {
    const username = str(req.body && req.body.username, 40).toLowerCase();
    const password = String((req.body && req.body.password) || '');
    const key = req.ip + '|' + username;
    if (A.limited(key)) throw new HttpError(429, 'Too many attempts. Wait 15 minutes and try again.');
    const u = await db.get('SELECT * FROM users WHERE username = ? AND active = 1', [username]);
    const ok = A.verifyPassword(password, u ? u.password_hash : A.DUMMY_HASH) && !!u;
    if (!ok) { A.recordFail(key); throw new HttpError(401, 'Wrong username or password.'); }
    A.clearFails(key);
    const token = await A.createSession(db, u.id);
    res.setHeader('Set-Cookie', A.cookieHeader(token, A.SESSION_DAYS * 86400, req.secure));
    res.json({ user: { id: u.id, username: u.username, name: u.name, role: u.role } });
  }));

  api.post('/logout', h(async (req, res) => {
    if (req.sessionId) await db.run('DELETE FROM sessions WHERE id = ?', [req.sessionId]);
    res.setHeader('Set-Cookie', A.cookieHeader('', 0, req.secure));
    res.json({ ok: true });
  }));

  api.get('/me', auth, (req, res) => res.json({ user: req.user }));

  api.post('/me/password', auth, h(async (req, res) => {
    const { current, next: pw } = req.body || {};
    const u = await db.get('SELECT password_hash FROM users WHERE id = ?', [req.user.id]);
    if (!A.verifyPassword(String(current || ''), u.password_hash)) throw bad('Your current password is wrong.');
    if (typeof pw !== 'string' || pw.length < 8) throw bad('The new password needs at least 8 characters.');
    await db.run('UPDATE users SET password_hash = ? WHERE id = ?', [A.hashPassword(pw), req.user.id]);
    await db.run('DELETE FROM sessions WHERE user_id = ? AND id <> ?', [req.user.id, req.sessionId]);
    res.json({ ok: true });
  }));

  /* ----- records ----- */
  api.get('/state', auth, h(async (req, res) => {
    const rows = await db.all('SELECT col, id, data FROM docs');
    const out = { version: hub.version };
    COLS.forEach(c => { out[c] = []; });
    for (const r of rows) {
      if (!out[r.col]) continue;
      try { out[r.col].push(Object.assign({ id: r.id }, JSON.parse(r.data))); } catch (e) { /* skip a damaged row */ }
    }
    res.json(out);
  }));

  api.get('/events', auth, (req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.write('retry: 5000\n\n');
    hub.add(res);
  });

  api.put('/docs/:col/:id', auth, h(async (req, res) => {
    const json = checkDoc(req.params.col, req.params.id, req.body);
    await upsert(db, req.params.col, req.params.id, json, req.user.id);
    changed(req);
    res.json({ ok: true });
  }));

  api.delete('/docs/:col/:id', owner, h(async (req, res) => {
    if (!COLS.includes(req.params.col)) throw new HttpError(404, 'Unknown section.');
    const r = await db.run('DELETE FROM docs WHERE col = ? AND id = ?', [req.params.col, req.params.id]);
    if (!r.changes) throw new HttpError(404, 'That record was already deleted.');
    changed(req);
    res.json({ ok: true });
  }));

  // Restore a backup file (from this app or the Claude artifact). Same IDs are replaced, others kept.
  api.post('/import', owner, h(async (req, res) => {
    const b = req.body || {};
    const items = [];
    for (const c of COLS) {
      if (b[c] === undefined) continue;
      if (!Array.isArray(b[c])) throw bad('That file isn’t a Club 1962 backup.');
      for (const r of b[c]) items.push([c, r && r.id, checkDoc(c, r && r.id, r)]);
    }
    if (!items.length) throw bad('No Club 1962 records found in that file.');
    if (items.length > 20000) throw bad('That backup is too large.');
    await db.tx(async t => { for (const [c, id, json] of items) await upsert(t, c, id, json, req.user.id); });
    changed(req);
    res.json({ count: items.length });
  }));

  /* ----- accounts (owner only) ----- */
  api.get('/users', owner, h(async (req, res) => {
    res.json({ users: (await db.all('SELECT * FROM users ORDER BY created_at')).map(mapUser) });
  }));

  api.post('/users', owner, h(async (req, res) => {
    const b = req.body || {};
    const username = str(b.username, 40).toLowerCase(), name = str(b.name, 80);
    const role = b.role === 'owner' ? 'owner' : 'staff';
    if (!name) throw bad('Enter their name.');
    if (!/^[a-z0-9._-]{3,40}$/.test(username)) throw bad('Usernames need 3 or more letters or numbers (no spaces).');
    if (typeof b.password !== 'string' || b.password.length < 8) throw bad('The password needs at least 8 characters.');
    if (await db.get('SELECT id FROM users WHERE username = ?', [username])) throw new HttpError(409, 'That username is already taken.');
    const id = newId('u');
    await db.run('INSERT INTO users(id,username,name,role,password_hash,active,created_at) VALUES(?,?,?,?,?,?,?)',
      [id, username, name, role, A.hashPassword(b.password), 1, Date.now()]);
    res.json({ id });
  }));

  api.patch('/users/:id', owner, h(async (req, res) => {
    const b = req.body || {};
    const u = await db.get('SELECT * FROM users WHERE id = ?', [req.params.id]);
    if (!u) throw new HttpError(404, 'That account doesn’t exist.');
    const self = u.id === req.user.id;
    if (b.name !== undefined) { const n = str(b.name, 80); if (!n) throw bad('Enter their name.'); await db.run('UPDATE users SET name = ? WHERE id = ?', [n, u.id]); }
    if (b.role !== undefined) {
      if (self) throw bad('You can’t change your own role.');
      await db.run('UPDATE users SET role = ? WHERE id = ?', [b.role === 'owner' ? 'owner' : 'staff', u.id]);
    }
    if (b.active !== undefined) {
      if (self) throw bad('You can’t switch off your own account.');
      await db.run('UPDATE users SET active = ? WHERE id = ?', [b.active ? 1 : 0, u.id]);
      if (!b.active) await db.run('DELETE FROM sessions WHERE user_id = ?', [u.id]);
    }
    if (b.password !== undefined) {
      if (typeof b.password !== 'string' || b.password.length < 8) throw bad('The password needs at least 8 characters.');
      await db.run('UPDATE users SET password_hash = ? WHERE id = ?', [A.hashPassword(b.password), u.id]);
      if (!self) await db.run('DELETE FROM sessions WHERE user_id = ?', [u.id]);
    }
    res.json({ ok: true });
  }));

  api.use((req, res, next) => next(new HttpError(404, 'Not found.')));
  api.use((err, req, res, next) => {
    const status = err.status || (err.type === 'entity.parse.failed' ? 400 : err.type === 'entity.too.large' ? 413 : 500);
    if (status >= 500) console.error(err);
    res.status(status).json({ error: status >= 500 ? 'Something went wrong on the server. Try again.' : status === 413 ? 'That file is too large.' : err.message });
  });

  app.use('/api', api);

  const pub = path.join(__dirname, '..', 'public');
  app.use(express.static(pub, {
    index: 'index.html',
    setHeaders(res, file) {
      // Always revalidate the app shell so updates reach phones quickly.
      if (/\.(html|js|css|webmanifest)$/.test(file)) res.setHeader('Cache-Control', 'no-cache');
      if (file.endsWith('sw.js')) res.setHeader('Service-Worker-Allowed', '/');
    }
  }));
  app.get('/{*any}', (req, res) => { res.setHeader('Cache-Control', 'no-cache'); res.sendFile(path.join(pub, 'index.html')); });

  app.hub = hub;
  return app;
}

module.exports = { createApp, seed, today, COLS };
