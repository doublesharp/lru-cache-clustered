import cluster from 'node:cluster';
import { LRUCache } from 'lru-cache';
import { caches, dispatchOp, getOrCreateCache, installClusterListener, type ExecPayload } from './primary.js';
import { defaultClient, type IpcClient } from './worker.js';
import { type SerializableLruOptions, type Stats } from './messages.js';

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
}

export type MSetEntry<K, V> = [K, V] | [K, V, WriteOptions];

export interface FetchOptions extends WriteOptions {
  forceRefresh?: boolean;
}

export interface LRUCacheClusterOptions extends SerializableLruOptions {
  namespace?: string;
  timeout?: number;
  failsafe?: 'resolve' | 'reject';
}

interface InternalOptions {
  noInit?: boolean;
}

export class LRUCacheForClustersAsPromised<K = string, V = unknown> {
  readonly namespace: string;
  readonly timeout: number;
  readonly failsafe: 'resolve' | 'reject';
  readonly ready: Promise<void>;
  #lruOptions: SerializableLruOptions;
  readonly #client: IpcClient;
  // Per-instance in-flight dedup for fetch(). Concurrent callers within the
  // same instance piggyback locally before the primary-side single-flight lock
  // engages across instances and workers.
  readonly #inFlight = new Map<K, { promise: Promise<V> }>();

  constructor(options: LRUCacheClusterOptions & InternalOptions = {}) {
    this.namespace = options.namespace ?? 'default';
    this.timeout = options.timeout ?? 100;
    this.failsafe = options.failsafe === 'reject' ? 'reject' : 'resolve';
    const { namespace: _n, timeout: _t, failsafe: _f, noInit: _ni, ...lruOpts } = options;
    void _n;
    void _t;
    void _f;
    void _ni;
    this.#lruOptions = lruOpts;
    this.#client = defaultClient;

    if (cluster.isPrimary) {
      getOrCreateCache(this.namespace, this.#lruOptions);
      this.ready = Promise.resolve(undefined);
    } else if (!options.noInit) {
      // Swallow rejection so consumers can `await cache.ready` purely for
      // ordering without unhandled-rejection noise.
      this.ready = this.#dispatch<unknown>({ op: 'init', options: this.#lruOptions }).then(
        () => undefined,
        () => undefined,
      );
    } else {
      this.ready = Promise.resolve(undefined);
    }
  }

  static async getInstance<K = string, V = unknown>(
    options: LRUCacheClusterOptions = {},
  ): Promise<LRUCacheForClustersAsPromised<K, V>> {
    const instance = new LRUCacheForClustersAsPromised<K, V>({
      ...options,
      noInit: true,
    });
    if (cluster.isWorker) {
      await instance.#dispatchRequired<unknown>({
        op: 'init',
        options: instance.#lruOptions,
      });
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
  get(key: K) {
    return this.#dispatch<V | undefined>({ op: 'get', key });
  }
  set(key: K, value: V, opts?: WriteOptions) {
    return this.#dispatch<boolean>({
      op: 'set',
      key,
      value,
      ttl: opts?.ttl,
      size: opts?.size,
    });
  }
  delete(key: K) {
    return this.#dispatch<boolean>({ op: 'delete', key });
  }
  has(key: K) {
    return this.#dispatch<boolean>({ op: 'has', key });
  }
  peek(key: K) {
    return this.#dispatch<V | undefined>({ op: 'peek', key });
  }
  clear() {
    return this.#dispatch<void>({ op: 'clear' });
  }
  purgeStale() {
    return this.#dispatch<boolean>({ op: 'purgeStale' });
  }

  async mGet(keys: K[]): Promise<Map<K, V | undefined>> {
    const pairs = await this.#dispatch<Array<[K, V | undefined]>>({
      op: 'mGet',
      keys: keys,
    });
    return new Map(pairs);
  }
  mSet(entries: Iterable<MSetEntry<K, V>>, opts?: WriteOptions) {
    return this.#dispatch<void>({
      op: 'mSet',
      entries: [...entries].map((entry) =>
        entry.length === 3
          ? ([entry[0], entry[1], entry[2]] as [unknown, unknown, WriteOptions])
          : ([entry[0], entry[1]] as [unknown, unknown]),
      ),
      ttl: opts?.ttl,
      size: opts?.size,
    });
  }
  mDelete(keys: K[]) {
    return this.#dispatch<void>({ op: 'mDelete', keys: keys });
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

  incr(key: K, amount?: number, opts?: WriteOptions) {
    return this.#dispatch<number>({ op: 'incr', key, amount, ttl: opts?.ttl, size: opts?.size });
  }
  decr(key: K, amount?: number, opts?: WriteOptions) {
    return this.#dispatch<number>({ op: 'decr', key, amount, ttl: opts?.ttl, size: opts?.size });
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

  getRemainingTTL(key: K) {
    return this.#dispatch<number>({ op: 'getRemainingTTL', key });
  }
  setIfAbsent(key: K, value: V, opts?: WriteOptions) {
    return this.#dispatch<boolean>({
      op: 'setIfAbsent',
      key,
      value,
      ttl: opts?.ttl,
      size: opts?.size,
    });
  }
  load(entries: Array<[K, LRUCache.Entry<V>]>) {
    return this.#dispatch<void>({
      op: 'load',
      entries: entries,
    });
  }
  destroy() {
    this.#inFlight.clear();
    return this.#dispatch<boolean>({ op: 'destroy' });
  }
  healthCheck() {
    return this.#dispatchRequired<void>({ op: 'healthCheck' });
  }
  stats() {
    return this.#dispatch<Stats>({ op: 'stats' });
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

  #dispatch<T>(payload: ExecPayload): Promise<T> {
    return this.#dispatchWithFailsafe(payload, this.failsafe);
  }

  #dispatchRequired<T>(payload: ExecPayload): Promise<T> {
    return this.#dispatchWithFailsafe(payload, 'reject');
  }

  #dispatchWithFailsafe<T>(payload: ExecPayload, failsafe: 'resolve' | 'reject'): Promise<T> {
    const request = { ...payload, cacheOptions: this.#lruOptions } as ExecPayload;
    if (cluster.isPrimary) {
      try {
        return Promise.resolve(dispatchOp(this.namespace, request) as T);
      } catch (e) {
        return Promise.reject(e instanceof Error ? e : new Error(String(e)));
      }
    }
    return this.#client.sendToPrimary<T>(
      {
        namespace: this.namespace,
        timeout: this.timeout,
        failsafe,
      },
      request,
    );
  }
}

// Short alias — equivalent to `LRUCacheForClustersAsPromised`.
export { LRUCacheForClustersAsPromised as LRUCacheClustered };

export { memoize, type MemoizeOptions } from './memoize.js';
export { wrap, type Codec, type WrappedCache } from './codec.js';

export default LRUCacheForClustersAsPromised;
