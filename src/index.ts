import cluster from 'node:cluster';
import { LRUCache } from 'lru-cache';
import {
  caches,
  dispatchAndBroadcast,
  getOrCreateCache,
  getNamespaceVersion,
  installClusterListener,
  type ExecPayload,
} from './primary.js';
import { getDefaultClient } from './worker.js';
import { type SerializableLruOptions, type Stats } from './messages.js';
import { LocalL1Cache, encodeL1Key, type L1Stats } from './l1.js';

if (cluster.isPrimary) installClusterListener();

const FETCH_POLL_MS = 5;

// lru-cache@11 constrains generic K and V to non-nullish; mirror that locally
// so the registry's stored type lines up with the public getCache() return.
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
type NonNullish = {};

type FetchClaimResult<T> = { kind: 'value'; value: T } | { kind: 'leader'; token: string } | { kind: 'follower' };

export interface WriteOptions {
  ttl?: number;
  size?: number;
  updateL1?: boolean;
}

// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export type MSetEntry<K extends {}, V extends {}> = [K, V] | [K, V, WriteOptions];

export interface FetchOptions extends WriteOptions {
  forceRefresh?: boolean;
}

export type LocalL1Options = {
  enabled?: boolean;
  max?: number;
  maxSize?: number;
  ttl?: number;
  updateAgeOnGet?: boolean;
  allowStale?: boolean;
  cacheUndefined?: boolean;
  invalidation?: 'broadcast' | 'ttl-only';
  methods?: {
    get?: boolean;
    has?: boolean;
    fetch?: boolean;
    memoize?: boolean;
  };
  experimental?: boolean;
};

export interface LRUCacheClusterOptions extends SerializableLruOptions {
  namespace?: string;
  timeout?: number;
  failsafe?: 'resolve' | 'reject';
  localL1?: boolean | LocalL1Options;
}

interface InternalOptions {
  noInit?: boolean;
}

const DEFAULT_L1_TTL_MS = 5_000;
const DEFAULT_L1_MAX = 1_000;

type NormalizedL1 = {
  max: number;
  maxSize?: number;
  ttl: number;
  updateAgeOnGet: boolean;
  allowStale: boolean;
  cacheUndefined: boolean;
  invalidation: 'broadcast' | 'ttl-only';
  methods: { get: boolean; has: boolean; fetch: boolean; memoize: boolean };
};

function normalizeL1(
  raw: boolean | LocalL1Options | undefined,
  primary: SerializableLruOptions,
): NormalizedL1 | undefined {
  if (raw === undefined || raw === false) return undefined;
  const opts: LocalL1Options = raw === true ? { enabled: true } : raw;
  if (opts.enabled === false) return undefined;

  // Default L1 ttl: min(primaryTtl * 0.1, 5000), with 100ms floor.
  // If primary ttl is unset, default to 5000.
  // Hard cap: L1 ttl cannot exceed primary ttl.
  const requestedTtl = opts.ttl ?? Math.min((primary.ttl ?? Infinity) * 0.1, DEFAULT_L1_TTL_MS);
  const cappedTtl = primary.ttl !== undefined ? Math.min(requestedTtl, primary.ttl) : requestedTtl;
  const ttl = Math.max(100, Math.floor(cappedTtl));

  return {
    max: opts.max ?? DEFAULT_L1_MAX,
    maxSize: opts.maxSize,
    ttl,
    updateAgeOnGet: opts.updateAgeOnGet ?? true,
    allowStale: opts.allowStale ?? false,
    cacheUndefined: false, // forced false for v1; spec section 6.2
    invalidation: opts.invalidation ?? 'broadcast',
    methods: {
      get: opts.methods?.get ?? true,
      has: opts.methods?.has ?? true,
      fetch: opts.methods?.fetch ?? true,
      memoize: opts.methods?.memoize ?? true,
    },
  };
}

function encodeL1KeyOrUndefined(key: unknown): string | undefined {
  if (key === undefined || key === null) return undefined;
  try {
    return encodeL1Key(key);
  } catch {
    return undefined;
  }
}

// K and V are constrained to non-nullish to mirror lru-cache@11's own signature
// (`class LRUCache<K extends {}, V extends {}>`), since the primary enforces
// non-nullish at runtime via requireNonNullish(). Without the constraint, a
// caller could write `cache.set(undefined, ...)` and TypeScript would accept it
// only to fail at the IPC boundary. The {} default for V mirrors lru-cache's
// own default and means "any non-nullish value".
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export class LRUCacheForClustersAsPromised<K extends {} = string, V extends {} = {}> {
  readonly namespace: string;
  readonly timeout: number;
  readonly failsafe: 'resolve' | 'reject';
  readonly ready: Promise<void>;
  #lruOptions: SerializableLruOptions;
  // Per-instance in-flight dedup for fetch(). Concurrent callers within the
  // same instance piggyback locally before the primary-side single-flight lock
  // engages across instances and workers.
  readonly #inFlight = new Map<K, { promise: Promise<V> }>();
  readonly #l1?: LocalL1Cache<V & NonNullish>;
  readonly #l1Methods: { get: boolean; has: boolean; fetch: boolean; memoize: boolean };
  // eslint-disable-next-line no-unused-private-class-members
  readonly #l1CacheUndefined: boolean;
  #unsubscribeL1?: () => void;

  constructor(options: LRUCacheClusterOptions & InternalOptions = {}) {
    this.namespace = options.namespace ?? 'default';
    this.timeout = options.timeout ?? 100;
    this.failsafe = options.failsafe === 'reject' ? 'reject' : 'resolve';
    const { namespace: _n, timeout: _t, failsafe: _f, noInit: _ni, localL1: _l1, ...lruOpts } = options;
    void _n;
    void _t;
    void _f;
    void _ni;
    void _l1;
    this.#lruOptions = lruOpts;

    const l1Config = normalizeL1(options.localL1, lruOpts);
    this.#l1Methods = l1Config?.methods ?? { get: false, has: false, fetch: false, memoize: false };
    this.#l1CacheUndefined = l1Config?.cacheUndefined ?? false;
    if (l1Config) {
      this.#l1 = new LocalL1Cache<V & NonNullish>({
        max: l1Config.max,
        maxSize: l1Config.maxSize,
        ttl: l1Config.ttl,
        updateAgeOnGet: l1Config.updateAgeOnGet,
        allowStale: l1Config.allowStale,
      });
    }

    if (cluster.isPrimary) {
      getOrCreateCache(this.namespace, this.#lruOptions);
      if (this.#l1) {
        this.#l1.advanceLatestSeen(getNamespaceVersion(this.namespace));
      }
      this.ready = Promise.resolve(undefined);
    } else if (!options.noInit) {
      // Swallow rejection so consumers can `await cache.ready` purely for
      // ordering without unhandled-rejection noise.
      this.ready = this.#dispatchWithMeta<{ namespace: string; isNew: boolean; max: number; version: number }>(
        { op: 'init', options: this.#lruOptions },
        'reject',
      ).then(
        (r) => {
          if (this.#l1) {
            this.#l1.advanceLatestSeen(r.value.version);
            this.#installL1Subscription();
          }
        },
        () => undefined,
      );
    } else {
      this.ready = Promise.resolve(undefined);
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-empty-object-type
  static async getInstance<K extends {} = string, V extends {} = {}>(
    options: LRUCacheClusterOptions = {},
  ): Promise<LRUCacheForClustersAsPromised<K, V>> {
    const instance = new LRUCacheForClustersAsPromised<K, V>({
      ...options,
      noInit: true,
    });
    if (cluster.isWorker) {
      const r = await instance.#dispatchWithMeta<{ namespace: string; isNew: boolean; max: number; version: number }>(
        { op: 'init', options: instance.#lruOptions },
        'reject',
      );
      if (instance.#l1) {
        instance.#l1.advanceLatestSeen(r.value.version);
        instance.#installL1Subscription();
      }
    }
    return instance;
  }

  static bootstrap(): void {
    if (cluster.isPrimary) installClusterListener();
  }

  static getAllCaches(): Map<string, LRUCache<NonNullish, NonNullish>> {
    if (cluster.isWorker) {
      throw new Error('LRUCacheForClustersAsPromised.getAllCaches() must not be called from a worker');
    }
    return caches;
  }

  getCache(): LRUCache<K & NonNullish, V & NonNullish> | undefined {
    if (cluster.isWorker) {
      throw new Error('LRUCacheForClustersAsPromised.getCache() must not be called from a worker');
    }
    return caches.get(this.namespace) as LRUCache<K & NonNullish, V & NonNullish> | undefined;
  }

  // Per-method API:
  async get(key: K, opts?: { bypassL1?: boolean }): Promise<V | undefined> {
    const useL1 = this.#l1 && this.#l1Methods.get && !opts?.bypassL1;
    if (useL1) {
      const enc = encodeL1KeyOrUndefined(key);
      if (enc !== undefined) {
        const hit = this.#l1.get(enc);
        if (hit !== undefined) return hit;
      }
    }
    const r = await this.#dispatchWithMeta<V | undefined>({ op: 'get', key }, this.failsafe);
    if (useL1 && r.value !== undefined) {
      const enc = encodeL1KeyOrUndefined(key);
      if (enc !== undefined) this.#l1.set(enc, r.value, r.version);
    }
    return r.value;
  }
  async set(key: K, value: V, opts?: WriteOptions): Promise<boolean> {
    if (this.#l1) {
      const enc = encodeL1KeyOrUndefined(key);
      if (enc !== undefined) this.#l1.delete(enc);
    }
    const r = await this.#dispatchWithMeta<boolean>(
      { op: 'set', key, value, ttl: opts?.ttl, size: opts?.size },
      this.failsafe,
    );
    if (this.#l1) this.#l1.advanceLatestSeen(r.version);
    if (this.#l1 && opts?.updateL1 && r.value === true) {
      const enc = encodeL1KeyOrUndefined(key);
      if (enc !== undefined) this.#l1.set(enc, value, r.version);
    }
    return r.value;
  }
  async delete(key: K): Promise<boolean> {
    if (this.#l1) {
      const enc = encodeL1KeyOrUndefined(key);
      if (enc !== undefined) this.#l1.delete(enc);
    }
    const r = await this.#dispatchWithMeta<boolean>({ op: 'delete', key }, this.failsafe);
    if (this.#l1) this.#l1.advanceLatestSeen(r.version);
    return r.value;
  }
  async has(key: K, opts?: { bypassL1?: boolean }): Promise<boolean> {
    const useL1 = this.#l1 && this.#l1Methods.has && !opts?.bypassL1;
    if (useL1) {
      const enc = encodeL1KeyOrUndefined(key);
      if (enc !== undefined) {
        const hit = this.#l1.get(enc);
        if (hit !== undefined) return true;
      }
    }
    const r = await this.#dispatchWithMeta<boolean>({ op: 'has', key }, this.failsafe);
    return r.value;
  }
  async peek(key: K, opts?: { bypassL1?: boolean }): Promise<V | undefined> {
    const useL1 = this.#l1 && !opts?.bypassL1;
    if (useL1) {
      const enc = encodeL1KeyOrUndefined(key);
      if (enc !== undefined) {
        const hit = this.#l1.get(enc);
        if (hit !== undefined) return hit;
      }
    }
    const r = await this.#dispatchWithMeta<V | undefined>({ op: 'peek', key }, this.failsafe);
    if (useL1 && r.value !== undefined) {
      const enc = encodeL1KeyOrUndefined(key);
      if (enc !== undefined) this.#l1.set(enc, r.value, r.version);
    }
    return r.value;
  }
  async clear(): Promise<void> {
    this.#l1?.clear();
    const r = await this.#dispatchWithMeta<void>({ op: 'clear' }, this.failsafe);
    if (this.#l1) this.#l1.advanceLatestSeen(r.version);
    return r.value;
  }
  async purgeStale(): Promise<boolean> {
    this.#l1?.clear();
    const r = await this.#dispatchWithMeta<boolean>({ op: 'purgeStale' }, this.failsafe);
    if (this.#l1) this.#l1.advanceLatestSeen(r.version);
    return r.value;
  }

  async mGet(keys: K[]): Promise<Map<K, V | undefined>> {
    const out = new Map<K, V | undefined>();
    const useL1 = this.#l1 && this.#l1Methods.get;
    const remainingKeys: K[] = [];
    if (useL1) {
      for (const k of keys) {
        const enc = encodeL1KeyOrUndefined(k);
        const hit = enc !== undefined ? this.#l1.get(enc) : undefined;
        if (hit !== undefined) out.set(k, hit);
        else remainingKeys.push(k);
      }
    } else {
      remainingKeys.push(...keys);
    }
    if (remainingKeys.length === 0) return out;

    const r = await this.#dispatchWithMeta<Array<[K, V | undefined]> | undefined>(
      { op: 'mGet', keys: remainingKeys },
      this.failsafe,
    );
    // Default cluster IPC uses JSON serialization, which rewrites
    // `undefined` inside arrays to `null`. Cache values are non-nullish, so
    // a null on this wire can only mean "the primary returned undefined for
    // a missing key". Normalize so the public Map<K, V | undefined> contract
    // holds in both primary and worker mode. The `?? []` covers the
    // failsafe='resolve' + IPC timeout case where dispatch resolves to
    // undefined; matches the previous `new Map(undefined)` empty-Map result.
    for (const [k, v] of r.value ?? []) {
      const value = v === null ? undefined : v;
      out.set(k, value);
      if (useL1 && value !== undefined) {
        const enc = encodeL1KeyOrUndefined(k);
        if (enc !== undefined) this.#l1.set(enc, value, r.version);
      }
    }
    return out;
  }
  async mSet(entries: Iterable<MSetEntry<K, V>>, opts?: WriteOptions): Promise<void> {
    this.#l1?.clear();
    const arr = [...entries].map((entry) =>
      entry.length === 3
        ? ([entry[0], entry[1], entry[2]] as [unknown, unknown, WriteOptions])
        : ([entry[0], entry[1]] as [unknown, unknown]),
    );
    const r = await this.#dispatchWithMeta<void>(
      { op: 'mSet', entries: arr, ttl: opts?.ttl, size: opts?.size },
      this.failsafe,
    );
    if (this.#l1) this.#l1.advanceLatestSeen(r.version);
    return r.value;
  }
  async mDelete(keys: K[]): Promise<void> {
    this.#l1?.clear();
    const r = await this.#dispatchWithMeta<void>({ op: 'mDelete', keys }, this.failsafe);
    if (this.#l1) this.#l1.advanceLatestSeen(r.version);
    return r.value;
  }

  keys() {
    return this.#dispatch<K[]>({ op: 'keys' });
  }
  values() {
    return this.#dispatch<V[]>({ op: 'values' });
  }
  entries() {
    return this.#dispatch<Array<[K, V]>>({ op: 'entries' });
  }
  dump() {
    return this.#dispatch<Array<[K, LRUCache.Entry<V>]>>({ op: 'dump' });
  }
  size() {
    return this.#dispatch<number>({ op: 'size' });
  }

  async incr(key: K, amount?: number, opts?: WriteOptions): Promise<number> {
    if (this.#l1) {
      const enc = encodeL1KeyOrUndefined(key);
      if (enc !== undefined) this.#l1.delete(enc);
    }
    const r = await this.#dispatchWithMeta<number>(
      { op: 'incr', key, amount, ttl: opts?.ttl, size: opts?.size },
      this.failsafe,
    );
    if (this.#l1) this.#l1.advanceLatestSeen(r.version);
    return r.value;
  }
  async decr(key: K, amount?: number, opts?: WriteOptions): Promise<number> {
    if (this.#l1) {
      const enc = encodeL1KeyOrUndefined(key);
      if (enc !== undefined) this.#l1.delete(enc);
    }
    const r = await this.#dispatchWithMeta<number>(
      { op: 'decr', key, amount, ttl: opts?.ttl, size: opts?.size },
      this.failsafe,
    );
    if (this.#l1) this.#l1.advanceLatestSeen(r.version);
    return r.value;
  }

  async allowStale(value?: boolean) {
    const next = await this.#dispatch<boolean>({ op: 'allowStale', value });
    this.#lruOptions.allowStale = next;
    return next;
  }
  async max(value?: number) {
    const next = await this.#dispatch<number>({ op: 'max', value });
    this.#lruOptions.max = next;
    return next;
  }
  async ttl(value?: number) {
    const next = await this.#dispatch<number>({ op: 'ttl', value });
    this.#lruOptions.ttl = next;
    return next;
  }

  async getRemainingTTL(key: K): Promise<number> {
    // Default cluster IPC uses JSON serialization, which rewrites `Infinity`
    // (lru-cache@11's "no TTL" sentinel) to `null`. Missing keys return 0,
    // and any active entry returns a positive number, so a null on this wire
    // can only mean Infinity. Normalize so the public Promise<number>
    // contract holds in both primary and worker mode. Strict `=== null` so
    // failsafe='resolve' timeouts (which dispatch undefined) still propagate
    // as undefined, matching the pattern for every other op under that mode.
    const ttl = await this.#dispatch<number | null>({ op: 'getRemainingTTL', key });
    return ttl === null ? Infinity : ttl;
  }
  async setIfAbsent(key: K, value: V, opts?: WriteOptions): Promise<boolean> {
    if (this.#l1) {
      const enc = encodeL1KeyOrUndefined(key);
      if (enc !== undefined) this.#l1.delete(enc);
    }
    const r = await this.#dispatchWithMeta<boolean>(
      { op: 'setIfAbsent', key, value, ttl: opts?.ttl, size: opts?.size },
      this.failsafe,
    );
    if (this.#l1) this.#l1.advanceLatestSeen(r.version);
    return r.value;
  }
  async load(entries: Array<[K, LRUCache.Entry<V>]>): Promise<void> {
    this.#l1?.clear();
    const r = await this.#dispatchWithMeta<void>({ op: 'load', entries }, this.failsafe);
    if (this.#l1) this.#l1.advanceLatestSeen(r.version);
    return r.value;
  }
  async destroy(): Promise<boolean> {
    this.#inFlight.clear();
    this.#unsubscribeL1?.();
    this.#unsubscribeL1 = undefined;
    this.#l1?.destroy();
    return this.#dispatch<boolean>({ op: 'destroy' });
  }
  healthCheck() {
    return this.#dispatchRequired<void>({ op: 'healthCheck' });
  }
  stats() {
    return this.#dispatch<Stats>({ op: 'stats' });
  }

  localStats(): L1Stats | undefined {
    return this.#l1?.stats();
  }

  clearLocal(): void {
    this.#l1?.clear();
  }

  invalidateLocal(key: K): void {
    if (!this.#l1) return;
    try {
      this.#l1.delete(encodeL1Key(key));
    } catch {
      // bad key encoding: nothing to invalidate
    }
  }

  // Materializes the full entries array up front, then yields — simpler than
  // streaming over IPC at the cost of a single large payload per iteration.
  async *[Symbol.asyncIterator](): AsyncIterableIterator<[K, V]> {
    const all = await this.entries();
    for (const pair of all) yield pair;
  }

  async fetch(key: K, fetcher: (key: K) => Promise<V> | V, opts?: FetchOptions): Promise<V> {
    // forceRefresh bypasses BOTH the cached-value check and the existing
    // in-flight slot; piggybacking on a previous fetcher's result would
    // contradict the "force a fresh fetch" intent. The new fetch overwrites
    // the in-flight slot so subsequent non-force callers can still dedup.
    //
    // Install the slot before the first await so concurrent callers piggyback
    // on a single miss-path `get()` instead of each issuing their own read.
    if (!opts?.forceRefresh) {
      const existing = this.#inFlight.get(key);
      if (existing) return existing.promise;
    }

    let slot!: { promise: Promise<V> };
    const run = async (): Promise<V> => {
      if (!opts?.forceRefresh) {
        const cached = await this.get(key);
        if (cached !== undefined) return cached;
      }
      let forceRefresh = opts?.forceRefresh === true;

      while (true) {
        const claim = await this.#dispatchRequired<FetchClaimResult<V>>({
          op: 'fetchClaim',
          key,
          forceRefresh,
        });

        if (claim.kind === 'value') return claim.value;
        if (claim.kind === 'leader') {
          try {
            const v = (await fetcher(key)) as V;
            await this.#dispatchRequired<boolean>({
              op: 'fetchStore',
              key,
              token: claim.token,
              value: v,
              ttl: opts?.ttl,
              size: opts?.size,
            });
            return v;
          } catch (error) {
            try {
              await this.#dispatchRequired<boolean>({
                op: 'fetchAbort',
                key,
                token: claim.token,
              });
            } catch {
              // Ignore cleanup failures and preserve the fetcher's error.
            }
            throw error;
          }
        }

        const observed = await this.peek(key);
        if (observed === undefined) {
          forceRefresh = false;
          await new Promise((resolve) => setTimeout(resolve, FETCH_POLL_MS));
          continue;
        }

        return observed;
      }
    };

    slot = { promise: run() };
    this.#inFlight.set(key, slot);
    try {
      return await slot.promise;
    } finally {
      // Identity check — a newer forceRefresh fetch may have replaced our
      // slot. Only clear if this slot is still current.
      if (this.#inFlight.get(key) === slot) this.#inFlight.delete(key);
    }
  }

  #installL1Subscription(): void {
    if (!this.#l1 || cluster.isPrimary) return;
    this.#unsubscribeL1 = getDefaultClient().subscribeInvalidations(this.namespace, (msg) => {
      this.#l1!.advanceLatestSeen(msg.version);
      if (msg.push === 'l1:invalidate') {
        try {
          // eslint-disable-next-line @typescript-eslint/no-empty-object-type
          this.#l1!.delete(encodeL1Key(msg.key as {}));
        } catch {
          // Symbol or unencodable key: no-op
        }
      } else {
        this.#l1!.clear();
      }
    });
  }

  #dispatch<T>(payload: ExecPayload): Promise<T> {
    return this.#dispatchWithMeta<T>(payload, this.failsafe).then((r) => r.value);
  }

  #dispatchRequired<T>(payload: ExecPayload): Promise<T> {
    return this.#dispatchWithMeta<T>(payload, 'reject').then((r) => r.value);
  }

  async #dispatchWithMeta<T>(
    payload: ExecPayload,
    failsafe: 'resolve' | 'reject',
  ): Promise<{ value: T; version: number }> {
    const request = { ...payload, cacheOptions: this.#lruOptions } as ExecPayload;
    if (cluster.isPrimary) {
      try {
        const r = dispatchAndBroadcast(this.namespace, request);
        return { value: r.value as T, version: r.version };
      } catch (e) {
        // Primary-mode errors always reject; failsafe only applies to IPC
        // timeouts in worker mode.
        throw e instanceof Error ? e : new Error(String(e));
      }
    }
    return getDefaultClient().sendToPrimaryWithMeta<T>(
      { namespace: this.namespace, timeout: this.timeout, failsafe },
      request,
    );
  }
}

// Short alias — equivalent to `LRUCacheForClustersAsPromised`.
export { LRUCacheForClustersAsPromised as LRUCacheClustered };

export { memoize, type MemoizeOptions } from './memoize.js';
export { wrap, type Codec, type WrappedCache } from './codec.js';

export default LRUCacheForClustersAsPromised;
