'use strict';
// Async SQLite access through libSQL: a local file in development, a hosted Turso database on Vercel.
// The API mirrors better-sqlite3 (db.prepare(sql).get/all/run) but every call returns a promise,
// and db.transaction(fn) transparently routes all statements made inside fn to one transaction.
const fs = require('fs');
const path = require('path');
const { AsyncLocalStorage } = require('node:async_hooks');
const { createClient } = require('@libsql/client');
const config = require('../config');

if (config.databaseUrl.startsWith('file:')) fs.mkdirSync(path.dirname(config.databaseUrl.replace(/^file:/, '')), { recursive: true });
const client = createClient({ url: config.databaseUrl, authToken: config.databaseToken || undefined });
const als = new AsyncLocalStorage();

function norm(args) {
  if (args.length === 1 && args[0] && typeof args[0] === 'object' && !Array.isArray(args[0])) {
    return Object.fromEntries(Object.entries(args[0]).map(([k, v]) => [k, v === undefined ? null : v]));
  }
  return args.flat().map((v) => (v === undefined ? null : typeof v === 'boolean' ? +v : v));
}
const exec = (sql, args) => (als.getStore() || client).execute({ sql, args: norm(args) });
const plain = (row) => ({ ...row });

function prepare(sql) {
  return {
    async get(...a) { const r = await exec(sql, a); return r.rows[0] ? plain(r.rows[0]) : undefined; },
    async all(...a) { return (await exec(sql, a)).rows.map(plain); },
    async run(...a) { const r = await exec(sql, a); return { changes: r.rowsAffected, lastInsertRowid: r.lastInsertRowid == null ? 0 : Number(r.lastInsertRowid) }; },
  };
}

function transaction(fn) {
  return async (...args) => {
    if (als.getStore()) return fn(...args); // already inside a transaction
    const tx = await client.transaction('write');
    try {
      const out = await als.run(tx, () => fn(...args));
      await tx.commit();
      return out;
    } catch (e) {
      try { await tx.rollback(); } catch { /* ignore */ }
      throw e;
    } finally { tx.close(); }
  };
}
const execScript = (sql) => client.executeMultiple(sql);

async function migrate(log = () => {}) {
  await client.execute(`CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT (datetime('now')))`);
  const dir = path.join(__dirname, 'migrations');
  const done = new Set((await prepare('SELECT name FROM _migrations').all()).map((r) => r.name));
  let n = 0;
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) {
    if (done.has(f)) continue;
    await client.executeMultiple(fs.readFileSync(path.join(dir, f), 'utf8'));
    await prepare('INSERT INTO _migrations (name) VALUES (?)').run(f);
    log(`applied ${f}`);
    n++;
  }
  return n;
}

module.exports = { prepare, transaction, exec: execScript, migrate, client };
