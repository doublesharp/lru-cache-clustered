import type { LRUCacheForClustersAsPromised } from './index.js';

export interface MemoizeOptions {
  ttl?: number;
}

// Worker-local in-flight dedup table, keyed by cache instance. Different cache
// instances get separate dedup maps; concurrent calls in the same worker for
// the same key share a single Promise. Different workers will not share the
// in-flight slot, so they may both invoke `fn` (matching the existing
// per-worker semantics elsewhere in this library).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const inFlightByCache = new WeakMap<object, Map<string, Promise<any>>>();

// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export function memoize<Args extends unknown[], V extends {}>(
  cache: LRUCacheForClustersAsPromised<string, V>,
  fn: (...args: Args) => Promise<V> | V,
  keyFn: (...args: Args) => string,
  opts?: MemoizeOptions,
): (...args: Args) => Promise<V> {
  const ttl = opts?.ttl;

  return async (...args: Args): Promise<V> => {
    const key = keyFn(...args);

    const cached = await cache.get(key);
    if (cached !== undefined) {
      return cached;
    }

    let inFlight = inFlightByCache.get(cache);
    if (!inFlight) {
      inFlight = new Map<string, Promise<V>>();
      inFlightByCache.set(cache, inFlight);
    }

    const existing = inFlight.get(key) as Promise<V> | undefined;
    if (existing) {
      return existing;
    }

    const pending: Promise<V> = (async () => {
      const value = await fn(...args);
      await cache.set(key, value, ttl !== undefined ? { ttl } : undefined);
      return value;
    })();

    inFlight.set(key, pending);

    try {
      return await pending;
    } finally {
      // Clear the slot regardless of success/failure so a failed call doesn't
      // poison subsequent retries.
      const map = inFlightByCache.get(cache);
      if (map?.get(key) === pending) {
        map.delete(key);
      }
    }
  };
}
