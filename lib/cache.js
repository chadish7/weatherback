// Two-level TTL cache for NOAA responses:
//   1. In memory: fast, and de-duplicates concurrent requests for the same key.
//   2. SQLite (Node's built-in node:sqlite): survives restarts and deploys.
// Values must be JSON-serializable. If the database can't be opened, the cache runs memory-only.

import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const DB_PATH = process.env.WEATHERBACK_DB || join(root, 'cache', 'weatherback.sqlite');
const MAX_MEMORY_ENTRIES = 2000;
const PURGE_EVERY_MS = 60 * 60_000;

const memory = new Map();
let db = null;
let getRow;
let putRow;
let purgeRows;

try {
  mkdirSync(dirname(DB_PATH), { recursive: true });
  db = new DatabaseSync(DB_PATH);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    CREATE TABLE IF NOT EXISTS cache (
      key     TEXT PRIMARY KEY,
      value   TEXT NOT NULL,
      expires INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS cache_expires ON cache (expires);
  `);
  getRow = db.prepare('SELECT value, expires FROM cache WHERE key = ? AND expires > ?');
  putRow = db.prepare(
    'INSERT INTO cache (key, value, expires) VALUES (?, ?, ?) ' +
      'ON CONFLICT (key) DO UPDATE SET value = excluded.value, expires = excluded.expires',
  );
  purgeRows = db.prepare('DELETE FROM cache WHERE expires <= ?');
  purge();
  setInterval(purge, PURGE_EVERY_MS).unref();
} catch (err) {
  console.warn(`[cache] SQLite unavailable at ${DB_PATH}, using memory only: ${err.message}`);
  db = null;
}

function purge() {
  try {
    const { changes } = purgeRows.run(Date.now());
    if (changes) db.exec('PRAGMA optimize');
  } catch (err) {
    console.warn('[cache] purge failed:', err.message);
  }
}

function remember(key, promise, expires, value) {
  memory.set(key, { promise, expires, value, settled: value !== undefined });
  if (memory.size > MAX_MEMORY_ENTRIES) {
    const now = Date.now();
    for (const [k, v] of memory) {
      if (v.expires <= now || memory.size > MAX_MEMORY_ENTRIES) memory.delete(k);
      if (memory.size <= MAX_MEMORY_ENTRIES) break;
    }
  }
}

export function cached(key, ttlMs, loader) {
  const now = Date.now();
  const hit = memory.get(key);
  if (hit && hit.expires > now) return hit.promise;

  if (db) {
    try {
      const row = getRow.get(key, now);
      if (row) {
        const value = JSON.parse(row.value);
        const promise = Promise.resolve(value);
        remember(key, promise, row.expires, value);
        return promise;
      }
    } catch (err) {
      console.warn('[cache] read failed:', err.message);
    }
  }

  const expires = now + ttlMs;
  const promise = loader();
  remember(key, promise, expires);
  promise.then(
    (value) => {
      const entry = memory.get(key);
      if (entry?.promise === promise) Object.assign(entry, { value, settled: true });
      if (!db) return;
      try {
        putRow.run(key, JSON.stringify(value), expires);
      } catch (err) {
        console.warn('[cache] write failed:', err.message);
      }
    },
    () => {
      // Don't keep failures around.
      if (memory.get(key)?.promise === promise) memory.delete(key);
    },
  );
  return promise;
}

/**
 * Synchronous lookup for callers that cache data piece by piece (per day, per station) and
 * fetch only what's missing. Returns `undefined` on a miss or expiry. `null` is a valid cached value
 * (e.g. "NOAA had nothing for this day when we asked").
 */
export function peek(key) {
  const now = Date.now();
  const hit = memory.get(key);
  if (hit && hit.expires > now && hit.settled) return hit.value;
  if (!db) return undefined;
  try {
    const row = getRow.get(key, now);
    if (!row) return undefined;
    const value = JSON.parse(row.value);
    remember(key, Promise.resolve(value), row.expires, value);
    return value;
  } catch (err) {
    console.warn('[cache] read failed:', err.message);
    return undefined;
  }
}

/** Store a value directly (memory + SQLite). */
export function put(key, value, ttlMs) {
  const expires = Date.now() + ttlMs;
  remember(key, Promise.resolve(value), expires, value);
  if (!db) return;
  try {
    putRow.run(key, JSON.stringify(value), expires);
  } catch (err) {
    console.warn('[cache] write failed:', err.message);
  }
}

/** Write several values in one SQLite transaction. `entries` is [[key, value, ttlMs], ...]. */
export function putMany(entries) {
  if (!db) {
    for (const [k, v, ttl] of entries) put(k, v, ttl);
    return;
  }
  try {
    db.exec('BEGIN');
    for (const [k, v, ttl] of entries) put(k, v, ttl);
    db.exec('COMMIT');
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {
      /* ignore */
    }
    console.warn('[cache] batch write failed:', err.message);
  }
}

/** Run `loader` once per key at a time; concurrent callers share the same promise. Not cached afterwards. */
const inflight = new Map();
export function once(key, loader) {
  if (inflight.has(key)) return inflight.get(key);
  const promise = loader().finally(() => inflight.delete(key));
  inflight.set(key, promise);
  return promise;
}
