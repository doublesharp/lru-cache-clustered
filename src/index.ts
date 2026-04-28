import cluster from 'node:cluster';
import { LRUCache } from 'lru-cache';
import { caches, dispatchOp, getOrCreateCache, installClusterListener, type ExecPayload } from './primary.js';
import { defaultClient, type IpcClient } from './worker.js';
import { type SerializableLruOptions, type Stats } from './messages.js';

if (cluster.isPrimary) installClusterListener();

// lru-cache@11 constrains generic K and V to non-nullish; mirror that locally
// so the registry's stored type lines up with the public getCache() return.
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
type NonNullish = {};

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
  readonly #lruOptions: SerializableLruOptions;
  readonly #client: IpcClient;
  // Per-instance in-flight dedup for fetch(). Two `LRUCacheForClustersAsPromised`
  // instances pointing at the same namespace each have their own #inFlight map,
  // so concurrent fetches across separate instances will each invoke the
  // fetcher — even within a single worker. Likewise, different workers don't
  // share in-flight state. If at-most-once invocation across the cluster is
  // required, the fetcher needs its own coordination.
  readonly #inFlight = new Map<K, Promise<V>>();

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
      await instance.#dispatch<unknown>({
        op: 'init',
        options: instance.#lruOptions,
      });
    }
    return instance;
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
  set(key: K, value: V, opts?: { ttl?: number }) {
    return this.#dispatch<boolean>({
      op: 'set',
      key,
      value,
      ttl: opts?.ttl,
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
  mSet(entries: Iterable<[K, V]>, opts?: { ttl?: number }) {
    return this.#dispatch<void>({
      op: 'mSet',
      entries: [...entries] as Array<[unknown, unknown]>,
      ttl: opts?.ttl,
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

  incr(key: K, amount?: number, opts?: { ttl?: number }) {
    return this.#dispatch<number>({ op: 'incr', key, amount, ttl: opts?.ttl });
  }
  decr(key: K, amount?: number, opts?: { ttl?: number }) {
    return this.#dispatch<number>({ op: 'decr', key, amount, ttl: opts?.ttl });
  }

  allowStale(value?: boolean) {
    return this.#dispatch<boolean>({ op: 'allowStale', value });
  }
  max(value?: number) {
    return this.#dispatch<number>({ op: 'max', value });
  }
  ttl(value?: number) {
    return this.#dispatch<number>({ op: 'ttl', value });
  }

  getRemainingTTL(key: K) {
    return this.#dispatch<number>({ op: 'getRemainingTTL', key });
  }
  setIfAbsent(key: K, value: V, opts?: { ttl?: number }) {
    return this.#dispatch<boolean>({
      op: 'setIfAbsent',
      key,
      value,
      ttl: opts?.ttl,
    });
  }
  load(entries: Array<[K, LRUCache.Entry<V>]>) {
    return this.#dispatch<void>({
      op: 'load',
      entries: entries,
    });
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

  async fetch(
    key: K,
    fetcher: (key: K) => Promise<V> | V,
    opts?: { ttl?: number; forceRefresh?: boolean },
  ): Promise<V> {
    // forceRefresh bypasses BOTH the cached-value check and the existing
    // in-flight slot; piggybacking on a previous fetcher's result would
    // contradict the "force a fresh fetch" intent. The new fetch overwrites
    // the in-flight slot so subsequent non-force callers can still dedup.
    if (!opts?.forceRefresh) {
      const cached = await this.get(key);
      if (cached !== undefined) return cached;
      const existing = this.#inFlight.get(key);
      if (existing) return existing;
    }
    const run = async (): Promise<V> => {
      const v = await fetcher(key);
      await this.set(key, v, { ttl: opts?.ttl });
      return v;
    };
    const p = run();
    this.#inFlight.set(key, p);
    try {
      return await p;
    } finally {
      // Identity check — a newer forceRefresh fetch may have replaced our
      // slot. Only clear if this promise is still the slot's value.
      if (this.#inFlight.get(key) === p) this.#inFlight.delete(key);
    }
  }

  #dispatch<T>(payload: ExecPayload): Promise<T> {
    if (cluster.isPrimary) {
      try {
        return Promise.resolve(dispatchOp(this.namespace, payload) as T);
      } catch (e) {
        return Promise.reject(e instanceof Error ? e : new Error(String(e)));
      }
    }
    return this.#client.sendToPrimary<T>(
      {
        namespace: this.namespace,
        timeout: this.timeout,
        failsafe: this.failsafe,
      },
      payload,
    );
  }
}

export { memoize, type MemoizeOptions } from './memoize.js';
export { wrap, type Codec, type WrappedCache } from './codec.js';

export default LRUCacheForClustersAsPromised;
