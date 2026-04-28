# lru-cache-for-clusters-as-promised

[![lru-cache-for-clusters-as-promised](https://img.shields.io/npm/v/lru-cache-for-clusters-as-promised.svg)](https://www.npmjs.com/package/lru-cache-for-clusters-as-promised)
[![CI](https://github.com/doublesharp/lru-cache-for-clusters-as-promised/actions/workflows/ci.yml/badge.svg)](https://github.com/doublesharp/lru-cache-for-clusters-as-promised/actions/workflows/ci.yml)
[![codecov](https://codecov.io/gh/doublesharp/lru-cache-for-clusters-as-promised/branch/main/graph/badge.svg)](https://codecov.io/gh/doublesharp/lru-cache-for-clusters-as-promised)
[![Downloads](https://img.shields.io/npm/dt/lru-cache-for-clusters-as-promised.svg)](https://www.npmjs.com/package/lru-cache-for-clusters-as-promised)

A cluster-safe Promise wrapper around [`lru-cache`](https://www.npmjs.com/package/lru-cache). Workers in a [`node:cluster`](https://nodejs.org/api/cluster.html) share a single cache that lives on the primary process, communicating via IPC. Outside cluster mode, it's a Promise interface to a plain in-process `lru-cache`.

> **v2.0 — TypeScript rewrite, breaking changes.** v2 targets Node ≥22, ships dual ESM + CJS, and adopts the `lru-cache@11` API surface. v1 consumers should pin to `^1.7.4` until they migrate. See **[Migrating from v1.x](#migrating-from-v1x)** below.

## Install

```sh
npm install lru-cache-for-clusters-as-promised
```

```sh
pnpm add lru-cache-for-clusters-as-promised
```

```sh
yarn add lru-cache-for-clusters-as-promised
```

## Usage

```ts
import cluster from 'node:cluster';
import { availableParallelism } from 'node:os';
import { LRUCacheForClustersAsPromised } from 'lru-cache-for-clusters-as-promised';

const cache = new LRUCacheForClustersAsPromised<string, string>({
  namespace: 'sessions',
  max: 1000,
  ttl: 60_000,
});

if (cluster.isPrimary) {
  for (let i = 0; i < availableParallelism(); i++) cluster.fork();
} else {
  await cache.set('user:42', JSON.stringify({ name: 'ada' }));
  const v = await cache.get('user:42');
  console.log(v); // {"name":"ada"}
}
```

## How it works

When you create a `LRUCacheForClustersAsPromised` instance, it branches at construction:

- **In the primary process** (`cluster.isPrimary === true`), the instance owns a real `LRUCache` registered under its `namespace`. Methods operate on it directly — no IPC.
- **In a worker process**, the instance sends an IPC request to the primary for every operation, awaits the matching response, and resolves your promise.

Multiple instances in different workers that share a `namespace` operate on the same primary-side cache. This is the savings: only one copy of the data lives in memory.

## Errors

When a primary-side handler throws, the worker's promise rejects with a reconstructed `Error` that preserves the original `name`, `message`, `code`, `stack`, and `cause` chain — not just the message. The reconstructed value is always a plain `Error` (subclass identity isn't crossed over IPC), but `err.name`, `err.code`, and `err.cause` are intact, so logging and cause-chain walking work. Errors are serialized as `{ name, message, code?, stack?, cause? }` on the wire.

## Options

All `LRUCache` constructor options from [`lru-cache@11`](https://github.com/isaacs/node-lru-cache) are passed through (`max`, `ttl`, `allowStale`, `updateAgeOnGet`, etc.). Plus:

| Option      | Type                    | Default     | Description                                                                                                   |
| ----------- | ----------------------- | ----------- | ------------------------------------------------------------------------------------------------------------- |
| `namespace` | `string`                | `'default'` | Logical name. Instances sharing a namespace share state on the primary.                                       |
| `timeout`   | `number`                | `100`       | Worker IPC timeout in ms.                                                                                     |
| `failsafe`  | `'resolve' \| 'reject'` | `'resolve'` | On worker IPC timeout: `'resolve'` resolves with `undefined`; `'reject'` rejects with `Error('IPC timeout')`. |

## API

### Static

| Method                                               | Description                                                                                                                                       |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `LRUCacheForClustersAsPromised.getInstance(options)` | Async factory. In a worker, awaits the init message so the primary has registered the namespace before returning. Use this when ordering matters. |
| `LRUCacheForClustersAsPromised.getAllCaches()`       | Returns the `Map<namespace, LRUCache>` registry. **Primary only** — throws in workers.                                                            |

### Instance

| Method                                        | Returns                           | Notes                                                                                                                      |
| --------------------------------------------- | --------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `getCache()`                                  | `LRUCache \| undefined`           | Underlying `lru-cache` for this namespace. **Primary only**.                                                               |
| `get(key)`                                    | `Promise<V \| undefined>`         |                                                                                                                            |
| `set(key, value, { ttl? })`                   | `Promise<boolean>`                |                                                                                                                            |
| `setIfAbsent(key, value, { ttl? })`           | `Promise<boolean>`                | Atomic on the primary. `false` if the key already exists.                                                                  |
| `delete(key)`                                 | `Promise<boolean>`                |                                                                                                                            |
| `has(key)`                                    | `Promise<boolean>`                |                                                                                                                            |
| `peek(key)`                                   | `Promise<V \| undefined>`         | Doesn't update LRU position.                                                                                               |
| `getRemainingTTL(key)`                        | `Promise<number>`                 | Milliseconds until expiry, or the `lru-cache` no-TTL sentinel.                                                             |
| `clear()`                                     | `Promise<void>`                   |                                                                                                                            |
| `purgeStale()`                                | `Promise<boolean>`                | Removes expired entries.                                                                                                   |
| `mGet(keys)`                                  | `Promise<Map<K, V \| undefined>>` |                                                                                                                            |
| `mSet(entries, { ttl? })`                     | `Promise<void>`                   | `entries: Iterable<[K, V]>`                                                                                                |
| `mDelete(keys)`                               | `Promise<void>`                   |                                                                                                                            |
| `keys()`                                      | `Promise<K[]>`                    | MRU first.                                                                                                                 |
| `values()`                                    | `Promise<V[]>`                    | MRU first.                                                                                                                 |
| `entries()`                                   | `Promise<[K,V][]>`                | MRU first.                                                                                                                 |
| `[Symbol.asyncIterator]()`                    | `AsyncIterableIterator<[K,V]>`    | `for await (const [k,v] of cache)`. Materializes the full set up front.                                                    |
| `dump()`                                      | `Promise<[K, Entry][]>`           | Serializable form.                                                                                                         |
| `load(entries)`                               | `Promise<void>`                   | Restores from a `dump()`.                                                                                                  |
| `size()`                                      | `Promise<number>`                 |                                                                                                                            |
| `stats()`                                     | `Promise<Stats>`                  | `{ hits, misses, sets, deletes, evictions, size, namespace }`.                                                             |
| `incr(key, amount?, { ttl? })`                | `Promise<number>`                 | Atomic on the primary. `ttl` is set on the **first** write only — subsequent increments don't reset it (rate-limiter use). |
| `decr(key, amount?, { ttl? })`                | `Promise<number>`                 | Same.                                                                                                                      |
| `fetch(key, fetcher, { ttl?, forceRefresh })` | `Promise<V>`                      | Cache-aside with worker-local in-flight dedup. Concurrent calls for the same key invoke `fetcher` once.                    |
| `max(value?)`                                 | `Promise<number>`                 | Getter and setter.                                                                                                         |
| `ttl(value?)`                                 | `Promise<number>`                 | Getter and setter.                                                                                                         |
| `allowStale(value?)`                          | `Promise<boolean>`                | Getter and setter.                                                                                                         |
| `ready`                                       | `Promise<void>`                   | Resolves once worker init has reached the primary. Useful before the very first op.                                        |

## `wrap` — codec / compression helper

Wraps a cache with an `encode`/`decode` codec so values are transparently transformed on the way in and out. Useful for compression (gzip/brotli), serialization (MessagePack), or any other symmetric transform. The codec choice stays with the caller — the library doesn't bundle a compression algorithm.

```ts
import { gzipSync, gunzipSync } from 'node:zlib';
import { LRUCacheForClustersAsPromised, wrap } from 'lru-cache-for-clusters-as-promised';

const inner = new LRUCacheForClustersAsPromised<string, Buffer>({ namespace: 'big-blobs', max: 1000 });

const cache = wrap(inner, {
  encode: (v: unknown) => gzipSync(Buffer.from(JSON.stringify(v), 'utf8')),
  decode: (raw: Buffer) => JSON.parse(gunzipSync(raw).toString('utf8')),
});

await cache.set('user:42', { id: 42, name: 'ada' });
const u = await cache.get('user:42'); // decoded back to the original object
```

Both `encode` and `decode` may be sync or async. The wrapped surface covers the value-touching methods (`get`, `set`, `setIfAbsent`, `peek`, `mGet`, `mSet`, `values`, `entries`, `[Symbol.asyncIterator]`, `fetch`) plus the lifecycle/metric pass-throughs (`has`, `delete`, `keys`, `size`, `clear`, `purgeStale`, `getRemainingTTL`, `stats`).

`incr`/`decr` and `dump`/`load` are **not** in the wrapped surface — they speak in numbers or the raw stored form. Reach them via `wrapped.cache` if you need them.

## `memoize` helper

Wraps a function as cache-aside in one line.

> **Per-worker dedup.** Concurrent invocations for the same key in the _same_ worker share a single in-flight `fetcher` call. Workers do not share the in-flight slot, so two workers racing on the same missing key may both invoke `fetcher`. The cache itself stays consistent (last-write-wins on the primary), but the underlying call may run more than once across the cluster. The same caveat applies to `cache.fetch(...)`. If at-most-once invocation is required, your `fetcher` needs its own coordination (e.g. a primary-side lock).

```ts
import { LRUCacheForClustersAsPromised, memoize } from 'lru-cache-for-clusters-as-promised';

const cache = new LRUCacheForClustersAsPromised<string, User>({ namespace: 'users', ttl: 60_000 });

const getUser = memoize(
  cache,
  (id: string) => fetchUserFromDB(id),
  (id) => `user:${id}`,
  { ttl: 60_000 },
);

await getUser('42'); // first call: hits DB
await getUser('42'); // second call: cached
```

## `wrap` codec — transparent encode/decode

`wrap(cache, codec)` returns a typed view of a cache where values pass through an encode/decode pair on the way in and out. Useful for compression, MessagePack, or any custom serialization. Both directions may be sync or async.

```ts
import { gzipSync, gunzipSync } from 'node:zlib';
import { LRUCacheForClustersAsPromised, wrap, type Codec } from 'lru-cache-for-clusters-as-promised';

const gzipJson: Codec<unknown, Buffer> = {
  encode: (v) => gzipSync(Buffer.from(JSON.stringify(v))),
  decode: (b) => JSON.parse(b.toString('utf8')),
};

const inner = new LRUCacheForClustersAsPromised<string, Buffer>({ namespace: 'compressed', max: 1000 });
const cache = wrap(inner, gzipJson);

await cache.set('user:42', { id: 42, name: 'ada' });
const u = await cache.get('user:42'); // round-tripped through gzip+JSON
```

The wrapped surface includes `get/set/setIfAbsent/has/peek/delete/getRemainingTTL`, the multi-ops, enumeration, `clear/purgeStale/stats`, `fetch`, and `[Symbol.asyncIterator]`. Operations that don't make sense through a codec are deliberately omitted: `incr`/`decr` (numeric, would not survive most codecs) and `dump`/`load` (speak the raw stored form). Reach those via `wrapped.cache`.

## Migrating from v1.x

The package's API now mirrors `lru-cache@11` directly. Common renames:

| v1.x                             | v2.0                                                        |
| -------------------------------- | ----------------------------------------------------------- |
| `del(k)`                         | `delete(k)`                                                 |
| `reset()`                        | `clear()`                                                   |
| `prune()`                        | `purgeStale()`                                              |
| `length()` / `itemCount()`       | `size()`                                                    |
| `stale(b)`                       | `allowStale(b)`                                             |
| `maxAge` option                  | `ttl` option                                                |
| `stale: bool` option             | `allowStale: bool` option                                   |
| `prune: '*/30 * * * * *'` option | _removed — schedule `purgeStale()` from your own scheduler_ |
| `parse` / `stringify` options    | _removed — caller serializes_                               |
| `setObject` / `getObject`        | _removed — caller does `JSON.stringify` themselves_         |
| `mGetObjects` / `mSetObjects`    | _removed_                                                   |
| `execute(method, ...args)`       | _removed — call methods directly_                           |

`incr` / `decr` are kept; they remain the cleanest way to do race-safe counters across workers.

## Debugging

Set `DEBUG=lru-cache-for-clusters-as-promised-*` for IPC tracing:

```sh
DEBUG=lru-cache-for-clusters-as-promised-* node app.js
```

Available namespaces:

- `lru-cache-for-clusters-as-promised-primary` — cache creation, registry events
- `lru-cache-for-clusters-as-promised-messages` — every request/response over IPC

## License

MIT
