// Tiny in-memory TTL cache. Also de-duplicates concurrent requests for the same key.

const store = new Map();
const MAX_ENTRIES = 2000;

export async function cached(key, ttlMs, loader) {
  const hit = store.get(key);
  const now = Date.now();
  if (hit && hit.expires > now) return hit.promise;

  const promise = loader();
  store.set(key, { promise, expires: now + ttlMs });
  // Don't keep failures around.
  promise.catch(() => {
    if (store.get(key)?.promise === promise) store.delete(key);
  });

  if (store.size > MAX_ENTRIES) {
    for (const [k, v] of store) {
      if (v.expires <= now || store.size > MAX_ENTRIES) store.delete(k);
      if (store.size <= MAX_ENTRIES) break;
    }
  }
  return promise;
}
