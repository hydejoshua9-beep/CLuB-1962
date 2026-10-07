'use strict';
const crypto = require('node:crypto');

const COOKIE = 'c62_session';
const SESSION_DAYS = 30;
const DAY = 86400000;

function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(pw, salt, 64, { N: 16384, r: 8, p: 1 });
  return 'scrypt$' + salt.toString('base64') + '$' + hash.toString('base64');
}
function verifyPassword(pw, stored) {
  const [alg, s, h] = String(stored || '').split('$');
  if (alg !== 'scrypt' || !s || !h) return false;
  const want = Buffer.from(h, 'base64');
  const got = crypto.scryptSync(String(pw), Buffer.from(s, 'base64'), want.length, { N: 16384, r: 8, p: 1 });
  return crypto.timingSafeEqual(want, got);
}
// Used when the username doesn't exist, so response time doesn't reveal it.
const DUMMY_HASH = hashPassword(crypto.randomBytes(8).toString('hex'));

const sha = s => crypto.createHash('sha256').update(s).digest('hex');
const newToken = () => crypto.randomBytes(32).toString('base64url');

function parseCookies(header) {
  const out = {};
  String(header || '').split(';').forEach(p => {
    const i = p.indexOf('=');
    if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
  });
  return out;
}

function cookieHeader(value, maxAgeSec, secure) {
  return COOKIE + '=' + value + '; Path=/; HttpOnly; SameSite=Lax; Max-Age=' + maxAgeSec + (secure ? '; Secure' : '');
}

async function createSession(db, userId) {
  const token = newToken(), now = Date.now();
  await db.run('INSERT INTO sessions(id,user_id,expires_at,created_at) VALUES(?,?,?,?)', [sha(token), userId, now + SESSION_DAYS * DAY, now]);
  await db.run('DELETE FROM sessions WHERE expires_at < ?', [now]);
  return token;
}

// Loads req.user from the session cookie. Extends sessions that are past halfway.
function sessionMiddleware(db) {
  return async (req, res, next) => {
    try {
      const token = parseCookies(req.headers.cookie)[COOKIE];
      if (token) {
        const id = sha(token), now = Date.now();
        const row = await db.get(
          'SELECT s.expires_at, u.id, u.username, u.name, u.role FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = ? AND u.active = 1',
          [id]
        );
        if (row && row.expires_at > now) {
          req.user = { id: row.id, username: row.username, name: row.name, role: row.role };
          req.sessionId = id;
          if (row.expires_at - now < (SESSION_DAYS / 2) * DAY) {
            await db.run('UPDATE sessions SET expires_at = ? WHERE id = ?', [now + SESSION_DAYS * DAY, id]);
            res.setHeader('Set-Cookie', cookieHeader(token, SESSION_DAYS * 86400, req.secure));
          }
        }
      }
      next();
    } catch (e) { next(e); }
  };
}

// Simple in-memory limiter for failed logins: 8 failures per 15 minutes per IP+username.
const fails = new Map();
const WINDOW = 15 * 60 * 1000, MAX_FAILS = 8;
function limited(key) {
  const f = fails.get(key);
  if (!f) return false;
  if (Date.now() - f.first > WINDOW) { fails.delete(key); return false; }
  return f.count >= MAX_FAILS;
}
function recordFail(key) {
  const f = fails.get(key);
  if (!f || Date.now() - f.first > WINDOW) fails.set(key, { first: Date.now(), count: 1 });
  else f.count++;
  if (fails.size > 5000) fails.clear();
}

module.exports = {
  COOKIE, SESSION_DAYS, hashPassword, verifyPassword, DUMMY_HASH, createSession, sessionMiddleware,
  cookieHeader, sha, limited, recordFail, clearFails: k => fails.delete(k)
};
