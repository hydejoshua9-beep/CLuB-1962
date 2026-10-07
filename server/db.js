'use strict';
// Tiny database layer. Uses PostgreSQL when DATABASE_URL is set, otherwise a
// local SQLite file (Node's built-in node:sqlite). SQL is written once with `?`
// placeholders and translated for Postgres.

const path = require('node:path');
const fs = require('node:fs');

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS users(
    id TEXT PRIMARY KEY,
    username TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    role TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    active INTEGER NOT NULL DEFAULT 1,
    created_at BIGINT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS sessions(
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    expires_at BIGINT NOT NULL,
    created_at BIGINT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id)`,
  // Every record (a sale, a stock item, an expense, a plan...) is one JSON document in a collection,
  // the same shape the Claude artifact version stores, so backups move between the two.
  `CREATE TABLE IF NOT EXISTS docs(
    col TEXT NOT NULL,
    id TEXT NOT NULL,
    data TEXT NOT NULL,
    updated_at BIGINT NOT NULL,
    updated_by TEXT,
    PRIMARY KEY(col, id)
  )`
];

const clean = v => (v === undefined ? null : typeof v === 'boolean' ? (v ? 1 : 0) : v);

async function openPostgres(url) {
  const { Pool, types } = require('pg');
  types.setTypeParser(20, v => Number(v)); // BIGINT -> number
  const local = /localhost|127\.0\.0\.1/.test(url);
  const pool = new Pool({
    connectionString: url,
    ssl: process.env.PGSSL === 'disable' || local ? false : { rejectUnauthorized: false },
    max: 5
  });
  const toPg = sql => { let i = 0; return sql.replace(/\?/g, () => '$' + (++i)); };
  const wrap = runner => ({
    all: (sql, p = []) => runner.query(toPg(sql), p.map(clean)).then(r => r.rows),
    get: (sql, p = []) => runner.query(toPg(sql), p.map(clean)).then(r => r.rows[0]),
    run: (sql, p = []) => runner.query(toPg(sql), p.map(clean)).then(r => ({ changes: r.rowCount }))
  });
  const db = wrap(pool);
  db.kind = 'postgres';
  db.tx = async fn => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const out = await fn(wrap(client));
      await client.query('COMMIT');
      return out;
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      throw e;
    } finally {
      client.release();
    }
  };
  db.close = () => pool.end();
  for (const s of SCHEMA) await pool.query(s);
  return db;
}

async function openSqlite(file) {
  const { DatabaseSync } = require('node:sqlite');
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const sq = new DatabaseSync(file);
  sq.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;');
  const stmts = new Map();
  const prep = sql => { let s = stmts.get(sql); if (!s) { s = sq.prepare(sql); stmts.set(sql, s); } return s; };
  const plain = obj => (obj ? Object.assign({}, obj) : obj);
  const db = {
    kind: 'sqlite',
    all: async (sql, p = []) => prep(sql).all(...p.map(clean)).map(plain),
    get: async (sql, p = []) => plain(prep(sql).get(...p.map(clean))),
    run: async (sql, p = []) => ({ changes: Number(prep(sql).run(...p.map(clean)).changes) }),
    close: async () => sq.close()
  };
  // One connection, so transactions are serialised with a simple promise lock.
  let lock = Promise.resolve();
  db.tx = fn => {
    const next = lock.then(async () => {
      sq.exec('BEGIN IMMEDIATE');
      try { const out = await fn(db); sq.exec('COMMIT'); return out; }
      catch (e) { sq.exec('ROLLBACK'); throw e; }
    });
    lock = next.catch(() => {});
    return next;
  };
  for (const s of SCHEMA) sq.exec(s.replace(/DOUBLE PRECISION/g, 'REAL'));
  return db;
}

async function openDb() {
  if (process.env.DATABASE_URL) return openPostgres(process.env.DATABASE_URL);
  const file = process.env.SQLITE_FILE || path.join(__dirname, '..', 'data', 'club1962.db');
  return openSqlite(file);
}

module.exports = { openDb };
