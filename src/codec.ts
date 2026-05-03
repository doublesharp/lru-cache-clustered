import type { Stats } from './messages.js';
import type { FetchOptions, LRUCacheForClustersAsPromised, MSetEntry, WriteOptions } from './index.js';

// A codec is a symmetric encode/decode pair. Both directions may be sync or
// async — gzip/brotli's sync flavours work fine, and so do MessagePack-style
// libraries that return Buffers, or async streams. The library never inspects
// or assumes anything about the encoded form beyond "lru-cache@11 accepts it",
// which means non-nullish.
export interface Codec<V, U> {
  encode(value: V): U | Promise<U>;
  decode(raw: U): V | Promise<V>;
}

// Methods that operate on or return cache values are wrapped through the
// codec; everything else (keys, lifecycle, metrics) passes through. We
// deliberately omit `incr`/`decr` (numeric ops that would not survive most
// codecs) and `dump`/`load` (which speak the raw stored form). Reach those
// via `wrapped.cache` when needed.
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface WrappedCache<K extends {}, V extends {}> {
  readonly cache: LRUCacheForClustersAsPromised<K, never>;
  readonly namespace: string;
  readonly ready: Promise<void>;

  get(key: K): Promise<V | undefined>;
  set(key: K, value: V, opts?: WriteOptions): Promise<boolean>;
  setIfAbsent(key: K, value: V, opts?: WriteOptions): Promise<boolean>;
  has(key: K): Promise<boolean>;
  peek(key: K): Promise<V | undefined>;
  delete(key: K): Promise<boolean>;
  getRemainingTTL(key: K): Promise<number>;

  mGet(keys: K[]): Promise<Map<K, V | undefined>>;
  mSet(entries: Iterable<MSetEntry<K, V>>, opts?: WriteOptions): Promise<void>;
  mDelete(keys: K[]): Promise<void>;

  keys(): Promise<K[]>;
  values(): Promise<V[]>;
  entries(): Promise<Array<[K, V]>>;
  size(): Promise<number>;
  [Symbol.asyncIterator](): AsyncIterableIterator<[K, V]>;

  clear(): Promise<void>;
  destroy(): Promise<boolean>;
  healthCheck(): Promise<void>;
  purgeStale(): Promise<boolean>;
  stats(): Promise<Stats>;

  fetch(key: K, fetcher: (key: K) => Promise<V> | V, opts?: FetchOptions): Promise<V>;
}

// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export function wrap<K extends {}, V extends {}, U extends {}>(
  cache: LRUCacheForClustersAsPromised<K, U>,
  codec: Codec<V, U>,
): WrappedCache<K, V> {
  const enc = (v: V): U | Promise<U> => codec.encode(v);
  const dec = (u: U): V | Promise<V> => codec.decode(u);

  // Cast once to a `never`-valued surface for the public `cache` field. Users
  // who want to bypass the codec can drop in via `wrapped.cache as any` — we
  // don't try to make that ergonomic, since doing so is the whole point of an
  // escape hatch.
  const underlying = cache as unknown as LRUCacheForClustersAsPromised<K, never>;

  const wrapped: WrappedCache<K, V> = {
    cache: underlying,
    namespace: cache.namespace,
    ready: cache.ready,

    async get(key) {
      const raw = await cache.get(key);
      return raw === undefined ? undefined : await dec(raw);
    },
    async set(key, value, opts) {
      return cache.set(key, await enc(value), opts);
    },
    async setIfAbsent(key, value, opts) {
      return cache.setIfAbsent(key, await enc(value), opts);
    },
    has: (key) => cache.has(key),
    async peek(key) {
      const raw = await cache.peek(key);
      return raw === undefined ? undefined : await dec(raw);
    },
    delete: (key) => cache.delete(key),
    getRemainingTTL: (key) => cache.getRemainingTTL(key),

    async mGet(keys) {
      const raw = await cache.mGet(keys);
      const out = new Map<K, V | undefined>();
      for (const [k, v] of raw) out.set(k, v === undefined ? undefined : await dec(v));
      return out;
    },
    async mSet(entries, opts) {
      const encoded: Array<MSetEntry<K, U>> = [];
      for (const entry of entries) {
        const [k, v, entryOpts] = entry;
        if (entryOpts === undefined) encoded.push([k, await enc(v)]);
        else encoded.push([k, await enc(v), entryOpts]);
      }
      return cache.mSet(encoded, opts);
    },
    mDelete: (keys) => cache.mDelete(keys),

    keys: () => cache.keys(),
    async values() {
      const raw = await cache.values();
      const out: V[] = [];
      for (const v of raw) out.push(await dec(v));
      return out;
    },
    async entries() {
      const raw = await cache.entries();
      const out: Array<[K, V]> = [];
      for (const [k, v] of raw) out.push([k, await dec(v)]);
      return out;
    },
    size: () => cache.size(),
    async *[Symbol.asyncIterator]() {
      for (const [k, v] of await this.entries()) yield [k, v];
    },

    clear: () => cache.clear(),
    destroy: () => cache.destroy(),
    healthCheck: () => cache.healthCheck(),
    purgeStale: () => cache.purgeStale(),
    stats: () => cache.stats(),

    async fetch(key, fetcher, opts) {
      // Reuse the underlying cache.fetch single-flight path. Pass an inner
      // fetcher that encodes the produced value — the cache stores and returns
      // the encoded form, then we decode on the way out.
      const raw = await cache.fetch(key, async (k) => await enc(await fetcher(k)), opts);
      return await dec(raw);
    },
  };

  return wrapped;
}
