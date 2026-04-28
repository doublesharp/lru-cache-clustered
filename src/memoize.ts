import type { LRUCacheForClustersAsPromised } from './index.js';

export interface MemoizeOptions {
  ttl?: number;
}

// Worker-local in-flight dedup table, keyed by cache instance. Different cache
// instances get separate dedup maps; concurrent calls in the same worker for
// the same key share a single Promise. Different workers will not share the
// in-flight slot, so they may both invoke `fn` (matching the existing
// per-worker semantics elsewhere in this library).
const inFlightByCache = new WeakMap<object, Map<unknown, Promise<unknown>>>();

// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export function memoize<Args extends unknown[], K extends {}, V extends {}>(
  cache: LRUCacheForClustersAsPromised<K, V>,
  fn: (...args: Args) => Promise<V> | V,
  keyFn: (...args: Args) => K,
  opts?: MemoizeOptions,
): (...args: Args) => Promise<V> {
  const ttl = opts?.ttl;

  return async (...args: Args): Promise<V> => {
    const key = keyFn(...args);

    let inFlight = inFlightByCache.get(cache);
    if (!inFlight) {
      inFlight = new Map<unknown, Promise<unknown>>();
      inFlightByCache.set(cache, inFlight);
    }
    const typedInFlight = inFlight as Map<K, Promise<V>>;

    const existing = typedInFlight.get(key);
    if (existing) {
      return existing;
    }

    const pending: Promise<V> = (async () => {
      const cached = await cache.get(key);
      if (cached !== undefined) {
        return cached;
      }
      const value = (await fn(...args)) as V;
      await cache.set(key, value, ttl !== undefined ? { ttl } : undefined);
      return value;
    })();

    typedInFlight.set(key, pending);

    try {
      return await pending;
    } finally {
      // Clear the slot regardless of success/failure so a failed call doesn't
      // poison subsequent retries.
      const map = inFlightByCache.get(cache) as Map<K, Promise<V>> | undefined;
      if (map?.get(key) === pending) {
        map.delete(key);
      }
    }
  };
}
