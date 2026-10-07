'use strict';
// End-to-end API tests. Runs against SQLite in memory, or Postgres if TEST_DATABASE_URL is set.
const test = require('node:test');
const assert = require('node:assert/strict');

process.env.OWNER_USERNAME = 'boss';
process.env.OWNER_PASSWORD = 'owner-pass-123';
process.env.OWNER_NAME = 'Test Owner';
if (process.env.TEST_DATABASE_URL) process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
else process.env.SQLITE_FILE = ':memory:';

const { openDb } = require('../server/db');
const { createApp, seed } = require('../server/app');

let server, base, db;

function client() {
  let cookie = '';
  return async (method, path, body, extra = {}) => {
    const headers = { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch', ...(extra.headers || {}) };
    if (cookie) headers.Cookie = cookie;
    const res = await fetch(base + '/api' + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const sc = res.headers.get('set-cookie');
    if (sc) cookie = sc.split(';')[0];
    const text = await res.text();
    let data; try { data = JSON.parse(text); } catch (e) { data = text; }
    return { status: res.status, data, headers: res.headers };
  };
}

test.before(async () => {
  db = await openDb();
  if (process.env.TEST_DATABASE_URL) {
    for (const t of ['docs', 'sessions', 'users']) await db.run('DELETE FROM ' + t);
  }
  await seed(db, () => {});
  const app = createApp(db);
  await new Promise(r => { server = app.listen(0, r); });
  base = 'http://127.0.0.1:' + server.address().port;
});
test.after(async () => { server.closeAllConnections(); server.close(); await db.close(); });

const owner = client(), staff = client(), anon = client();
const sale = { date: '2026-10-05', order: 'A163', customer: 'Test Buyer', product: 'Hoodie', size: 'M', color: 'Black', qty: 1, price: 60, payment: 'Zelle', status: 'Paid', note: '' };

test('requires sign in', async () => {
  assert.equal((await anon('GET', '/state')).status, 401);
  assert.equal((await anon('PUT', '/docs/sales/x1', sale)).status, 401);
  assert.equal((await anon('POST', '/login', { username: 'boss', password: 'wrong' })).status, 401);
});

test('blocks writes without the CSRF header', async () => {
  const r = await fetch(base + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'boss', password: 'owner-pass-123' }) });
  assert.equal(r.status, 403);
});

test('owner signs in and restores a backup', async () => {
  const r = await owner('POST', '/login', { username: 'BOSS', password: 'owner-pass-123' });
  assert.equal(r.status, 200);
  assert.equal(r.data.user.role, 'owner');
  const empty = await owner('GET', '/state');
  assert.deepEqual(empty.data.sales, []);
  const backup = {
    sales: [{ id: 's0001', ...sale }, { id: 's0002', ...sale, order: 'A164', status: 'Pending' }],
    inventory: [{ id: 'i01', sku: 'A1', product: 'Hoodie', size: 'M', color: 'Black', stock: 15, cost: 28.15, price: 65, reorder: 2 }],
    plans: [{ id: '2026-10', month: '2026-10', theme: 'Test', tasks: [{ t: 'Do it', done: false }] }]
  };
  const imp = await owner('POST', '/import', backup);
  assert.equal(imp.status, 200, JSON.stringify(imp.data));
  assert.equal(imp.data.count, 4);
  const s = await owner('GET', '/state');
  assert.equal(s.data.sales.length, 2);
  assert.equal(s.data.inventory[0].price, 65);
  assert.deepEqual(s.data.plans[0].tasks, [{ t: 'Do it', done: false }]);
  // Importing again replaces by ID instead of duplicating.
  await owner('POST', '/import', backup);
  assert.equal((await owner('GET', '/state')).data.sales.length, 2);
});

test('rejects bad records', async () => {
  assert.equal((await owner('PUT', '/docs/secrets/x1', sale)).status, 404);
  assert.equal((await owner('PUT', '/docs/sales/bad id!', sale)).status, 400);
  assert.equal((await owner('PUT', '/docs/sales/x1', [1, 2])).status, 400);
  assert.equal((await owner('PUT', '/docs/sales/x1', { note: 'x'.repeat(40000) })).status, 400);
  assert.equal((await owner('POST', '/import', { sales: 'nope' })).status, 400);
});

test('owner creates a staff account', async () => {
  const r = await owner('POST', '/users', { name: 'Jono', username: 'jono', password: 'staff-pass-1', role: 'staff' });
  assert.equal(r.status, 200);
  assert.equal((await owner('POST', '/users', { name: 'Dup', username: 'jono', password: 'staff-pass-1' })).status, 409);
  const l = await staff('POST', '/login', { username: 'jono', password: 'staff-pass-1' });
  assert.equal(l.data.user.role, 'staff');
  assert.equal((await staff('GET', '/users')).status, 403);
});

test('staff logs and edits sales but cannot delete or import', async () => {
  assert.equal((await staff('PUT', '/docs/sales/s0003', { ...sale, order: 'A165' })).status, 200);
  assert.equal((await staff('PUT', '/docs/sales/s0002', { ...sale, order: 'A164', status: 'Paid' })).status, 200);
  const s = await owner('GET', '/state');
  assert.equal(s.data.sales.length, 3);
  assert.equal(s.data.sales.find(x => x.id === 's0002').status, 'Paid');
  assert.equal(s.data.sales[0].id !== undefined, true);
  assert.equal((await staff('DELETE', '/docs/sales/s0003')).status, 403);
  assert.equal((await staff('POST', '/import', { sales: [] })).status, 403);
  assert.equal((await owner('DELETE', '/docs/sales/s0003')).status, 200);
  assert.equal((await owner('DELETE', '/docs/sales/s0003')).status, 404);
});

test('live updates announce changes', async () => {
  const res = await fetch(base + '/api/events', { headers: { Cookie: '' } });
  assert.equal(res.status, 401);
  const ctrl = new AbortController();
  const login = await fetch(base + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch' }, body: JSON.stringify({ username: 'boss', password: 'owner-pass-123' }) });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const stream = await fetch(base + '/api/events', { headers: { Cookie: cookie }, signal: ctrl.signal });
  const reader = stream.body.getReader();
  await owner('PUT', '/docs/ideas/d01', { title: 'Test idea', status: 'Idea' });
  const dec = new TextDecoder();
  let text = '';
  for (let i = 0; i < 5 && !text.includes('event: change'); i++) { const { value } = await reader.read(); text += dec.decode(value); }
  ctrl.abort();
  assert.match(text, /event: change/);
});

test('switching off an account signs it out', async () => {
  const users = (await owner('GET', '/users')).data.users;
  const j = users.find(u => u.username === 'jono');
  assert.equal((await owner('PATCH', '/users/' + j.id, { active: false })).status, 200);
  assert.equal((await staff('GET', '/state')).status, 401);
  const me = users.find(u => u.username === 'boss');
  assert.equal((await owner('PATCH', '/users/' + me.id, { active: false })).status, 400);
});

test('password change', async () => {
  assert.equal((await owner('POST', '/me/password', { current: 'nope', next: 'new-pass-456' })).status, 400);
  assert.equal((await owner('POST', '/me/password', { current: 'owner-pass-123', next: 'new-pass-456' })).status, 200);
  assert.equal((await client()('POST', '/login', { username: 'boss', password: 'new-pass-456' })).status, 200);
  assert.equal((await owner('POST', '/logout')).status, 200);
  assert.equal((await owner('GET', '/state')).status, 401);
});
