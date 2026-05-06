import { LRUCache } from 'lru-cache';

export type L1Stats = {
  enabled: true;
  hits: number;
  misses: number;
  sets: number;
  invalidations: number;
  evictions: number;
  staleHits: number;
  size: number;
  ipcAvoided: number;
};

type L1Envelope<V> = {
  value: V;
  version: number;
};

type L1EmitEvent = 'hit' | 'miss' | 'set' | 'invalidate' | 'evict' | 'stale-hit';

type L1EmitPayload = {
  key?: string; // encoded key, may be omitted for namespace-wide events
  version?: number;
  reason?: string;
};

type L1EmitFn = (event: L1EmitEvent, payload: L1EmitPayload) => void;

type L1ConstructorOptions = {
  max?: number;
  maxSize?: number;
  ttl?: number;
  updateAgeOnGet?: boolean;
  allowStale?: boolean;
  emit?: L1EmitFn; // optional; defaults to no-op
};

// Encode arbitrary cache keys into a string the L1 LRUCache can index by.
// Primitives use a typed prefix so 1 (number) and "1" (string) do not collide.
// Objects fall back to JSON.stringify; symbol keys are rejected because
// Symbol.toString is not stable across realms and the L1 would dedup by
// description, which is wrong.
//
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export function encodeL1Key(key: {}): string {
  switch (typeof key) {
    case 'string':
      return `s:${key}`;
    case 'number':
      return `n:${key}`;
    case 'boolean':
      return `b:${key}`;
    case 'bigint':
      return `i:${key.toString()}`;
    case 'symbol':
      throw new Error('L1 does not support symbol keys');
    default:
      return `o:${JSON.stringify(key)}`;
  }
}

const FRESH_STATS = (): L1Stats => ({
  enabled: true,
  hits: 0,
  misses: 0,
  sets: 0,
  invalidations: 0,
  evictions: 0,
  staleHits: 0,
  size: 0,
  ipcAvoided: 0,
});

// Per-instance L1 cache. One LocalL1Cache per LRUCacheForClustersAsPromised.
// Stores L1Envelope<V> so we can stamp each entry with the namespace version
// at the moment it was populated; later reads compare against the latest
// invalidation version we've observed for the namespace.
//
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export class LocalL1Cache<V extends {} = {}> {
  readonly #cache: LRUCache<string, L1Envelope<V>>;
  #latestSeen = 0;
  readonly #stats = FRESH_STATS();
  readonly #emit: L1EmitFn;

  constructor(opts: L1ConstructorOptions) {
    this.#emit = opts.emit ?? (() => undefined);
    const lruOpts = {
      max: opts.max ?? 1000,
      ttl: opts.ttl,
      updateAgeOnGet: opts.updateAgeOnGet ?? true,
      allowStale: opts.allowStale ?? false,
      maxSize: opts.maxSize,
      // sizeCalculation is required when maxSize is set, but for v1 we don't
      // expose it in the public LocalL1Options. If a caller passes maxSize,
      // we use a 1-per-entry calculation as a placeholder.
      ...(opts.maxSize !== undefined ? { sizeCalculation: () => 1 } : {}),
      dispose: (_value: L1Envelope<V>, key: string, reason: LRUCache.DisposeReason) => {
        if (reason === 'evict') {
          this.#stats.evictions += 1;
          this.#emit('evict', { key, reason: 'lru' });
        }
      },
    } as ConstructorParameters<typeof LRUCache<string, L1Envelope<V>>>[0];
    this.#cache = new LRUCache(lruOpts);
  }

  get(encodedKey: string): V | undefined {
    const entry = this.#cache.get(encodedKey);
    if (!entry) {
      this.#stats.misses += 1;
      this.#emit('miss', { key: encodedKey });
      return undefined;
    }
    if (entry.version < this.#latestSeen) {
      // Stamped before the latest invalidation; drop it.
      this.#cache.delete(encodedKey);
      this.#stats.misses += 1;
      this.#stats.staleHits += 1;
      this.#emit('stale-hit', { key: encodedKey });
      this.#emit('miss', { key: encodedKey });
      return undefined;
    }
    this.#stats.hits += 1;
    this.#stats.ipcAvoided += 1;
    this.#emit('hit', { key: encodedKey });
    return entry.value;
  }

  set(encodedKey: string, value: V, version: number): void {
    if (version < this.#latestSeen) {
      // Don't store an entry already known to be stale.
      return;
    }
    this.#cache.set(encodedKey, { value, version });
    this.#stats.sets += 1;
    this.#emit('set', { key: encodedKey, version });
  }

  delete(encodedKey: string): void {
    if (this.#cache.delete(encodedKey)) {
      this.#stats.invalidations += 1;
      this.#emit('invalidate', { key: encodedKey, reason: 'self' });
    }
  }

  clear(): void {
    if (this.#cache.size > 0) this.#stats.invalidations += 1;
    this.#cache.clear();
    this.#emit('invalidate', { reason: 'clear' });
  }

  advanceLatestSeen(version: number): void {
    if (version > this.#latestSeen) this.#latestSeen = version;
  }

  latestSeen(): number {
    return this.#latestSeen;
  }

  stats(): L1Stats {
    return { ...this.#stats, size: this.#cache.size };
  }

  // For tests / explicit teardown.
  destroy(): void {
    this.#cache.clear();
  }
}
