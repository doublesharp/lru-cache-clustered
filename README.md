# lru-cache-for-clusters-as-promised

[![lru-cache-for-clusters-as-promised](https://img.shields.io/npm/v/lru-cache-for-clusters-as-promised.svg)](https://www.npmjs.com/package/lru-cache-for-clusters-as-promised)
[![CI](https://github.com/doublesharp/lru-cache-for-clusters-as-promised/actions/workflows/ci.yml/badge.svg)](https://github.com/doublesharp/lru-cache-for-clusters-as-promised/actions/workflows/ci.yml)
[![codecov](https://codecov.io/gh/doublesharp/lru-cache-for-clusters-as-promised/branch/main/graph/badge.svg)](https://codecov.io/gh/doublesharp/lru-cache-for-clusters-as-promised)
[![Downloads](https://img.shields.io/npm/dt/lru-cache-for-clusters-as-promised.svg)](https://www.npmjs.com/package/lru-cache-for-clusters-as-promised)

**One LRU cache, shared across every worker in your `node:cluster` app.** A typed Promise wrapper around [`lru-cache`](https://www.npmjs.com/package/lru-cache) that lives on the primary process and is reached from workers via IPC — so memory only gets paid once, not per worker. Outside `cluster`, it's a Promise interface to a plain in-process `lru-cache`.

- **One copy in memory** — workers don't each duplicate the cache
- **Race-safe counters** — `incr` / `decr` are atomic on the primary, safe across N workers
- **Cache-aside in one line** — `fetch()` and `memoize()` dedupe concurrent calls per worker
- **Codec wrappers** — transparent gzip / MessagePack / custom encode-decode via `wrap()`
- **Per-namespace stats** — hits, misses, sets, deletes, evictions, size
- **TTL with rate-limiter semantics** — `incr` keeps the original expiration ticking
- **Modern** — TypeScript, dual ESM + CJS, Node ≥22, 100% test coverage, structured error transport

> **v2 is a breaking rewrite.** Node ≥22, dual ESM + CJS, `lru-cache@11`-shaped API. v1 users should pin to `^1.7.4` until they migrate — see [Migrating from v1.x](#migrating-from-v1x).

## Install

`lru-cache@11` is a peer dependency. Install it alongside this package so you control the version.

```sh
npm install lru-cache-for-clusters-as-promised lru-cache
pnpm add lru-cache-for-clusters-as-promised lru-cache
yarn add lru-cache-for-clusters-as-promised lru-cache
```

## Quick start

```ts
import cluster from 'node:cluster';
import { availableParallelism } from 'node:os';
import { ClusterCache } from 'lru-cache-for-clusters-as-promised';

const cache = new ClusterCache<string, string>({
  namespace: 'sessions',
  max: 1000,
  ttl: 60_000,
});

if (cluster.isPrimary) {
  for (let i = 0; i < availableParallelism(); i++) cluster.fork();
} else {
  await cache.set('user:42', JSON.stringify({ name: 'ada' }));
  console.log(await cache.get('user:42'));
  // {"name":"ada"} — every worker sees the same value
}
```

> **Naming.** `ClusterCache` is a short alias for `LRUCacheForClustersAsPromised`. Both refer to the same class — use whichever reads better in your code. The long name remains the canonical export for v1.x continuity.

## How it works

<p align="center">
  <img src="https://raw.githubusercontent.com/doublesharp/lru-cache-for-clusters-as-promised/main/assets/topology.svg" alt="One LRU cache shared across cluster workers via IPC. The primary process holds a Map of namespaced LRUCache instances; each worker sends typed IPC requests to the primary for every cache operation. In primary mode the dispatcher is invoked directly with no IPC." width="100%">
</p>

`new ClusterCache(...)` branches at construction:

- **In the primary** (`cluster.isPrimary === true`), the instance owns and directly operates on the in-process `LRUCache` for its namespace — no IPC, no allocation per call.
- **In a worker**, every operation becomes a typed IPC request to the primary; the returned Promise resolves with the response.

Instances in different workers that share a `namespace` operate on the same primary-side cache. That's where the memory savings come from.

## Options

All `LRUCache` constructor options from [`lru-cache@11`](https://github.com/isaacs/node-lru-cache) pass through (`max`, `ttl`, `allowStale`, `updateAgeOnGet`, …). Plus:

| Option      | Type                    | Default     | Description                                                                                                   |
| ----------- | ----------------------- | ----------- | ------------------------------------------------------------------------------------------------------------- |
| `namespace` | `string`                | `'default'` | Logical name. Instances sharing a namespace share state on the primary.                                       |
| `timeout`   | `number`                | `100`       | Worker IPC timeout in ms.                                                                                     |
| `failsafe`  | `'resolve' \| 'reject'` | `'resolve'` | On worker IPC timeout: `'resolve'` resolves with `undefined`; `'reject'` rejects with `Error('IPC timeout')`. |

> **`failsafe: 'resolve'` caveat.** On timeout, `'resolve'` returns `undefined` for _every_ op, regardless of declared return type. For `get` / `peek` that's natural; for `has` / `set` / `delete` / `incr` / `decr` / `size` it can surprise callers (`undefined + 1 === NaN`). Use `'reject'` if typed-shape correctness on timeout matters.

## API

### Static

| Method                              | Description                                                                                                       |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `ClusterCache.getInstance(options)` | Async factory. In a worker, awaits the init message so the primary has registered the namespace before returning. |
| `ClusterCache.getAllCaches()`       | Returns the `Map<namespace, LRUCache>` registry. **Primary only** — throws in workers.                            |

### Core

| Method                              | Returns                   | Notes                                                     |
| ----------------------------------- | ------------------------- | --------------------------------------------------------- |
| `get(key)`                          | `Promise<V \| undefined>` |                                                           |
| `set(key, value, { ttl? })`         | `Promise<boolean>`        |                                                           |
| `setIfAbsent(key, value, { ttl? })` | `Promise<boolean>`        | Atomic on the primary. `false` if the key already exists. |
| `delete(key)`                       | `Promise<boolean>`        |                                                           |
| `has(key)`                          | `Promise<boolean>`        |                                                           |
| `peek(key)`                         | `Promise<V \| undefined>` | Doesn't update LRU position.                              |
| `clear()`                           | `Promise<void>`           |                                                           |

### Multi

| Method                    | Returns                           | Notes                       |
| ------------------------- | --------------------------------- | --------------------------- |
| `mGet(keys)`              | `Promise<Map<K, V \| undefined>>` |                             |
| `mSet(entries, { ttl? })` | `Promise<void>`                   | `entries: Iterable<[K, V]>` |
| `mDelete(keys)`           | `Promise<void>`                   |                             |

### Enumeration

| Method                     | Returns                         | Notes                                                            |
| -------------------------- | ------------------------------- | ---------------------------------------------------------------- |
| `keys()`                   | `Promise<K[]>`                  | MRU first.                                                       |
| `values()`                 | `Promise<V[]>`                  | MRU first.                                                       |
| `entries()`                | `Promise<[K, V][]>`             | MRU first.                                                       |
| `[Symbol.asyncIterator]()` | `AsyncIterableIterator<[K, V]>` | `for await (const [k, v] of cache)` — materializes the full set. |
| `dump()`                   | `Promise<[K, Entry][]>`         | Serializable snapshot.                                           |
| `load(entries)`            | `Promise<void>`                 | Restores from a `dump()`.                                        |
| `size()`                   | `Promise<number>`               |                                                                  |

### Counters & cache-aside

| Method                                        | Returns           | Notes                                                                                                             |
| --------------------------------------------- | ----------------- | ----------------------------------------------------------------------------------------------------------------- |
| `incr(key, amount?, { ttl? })`                | `Promise<number>` | Atomic on the primary. `ttl` is set on the **first** write only; later increments don't reset it (rate limiters). |
| `decr(key, amount?, { ttl? })`                | `Promise<number>` | Same.                                                                                                             |
| `fetch(key, fetcher, { ttl?, forceRefresh })` | `Promise<V>`      | Cache-aside with worker-local in-flight dedup. See the [per-worker dedup caveat](#per-worker-dedup).              |

### Lifecycle, metrics, tunables

| Method                 | Returns                 | Notes                                                                                   |
| ---------------------- | ----------------------- | --------------------------------------------------------------------------------------- |
| `getRemainingTTL(key)` | `Promise<number>`       | ms until expiry. `Infinity` for keys with no TTL; `0` for missing keys.                 |
| `purgeStale()`         | `Promise<boolean>`      | Removes expired entries.                                                                |
| `stats()`              | `Promise<Stats>`        | `{ hits, misses, sets, deletes, evictions, size, namespace }`.                          |
| `getCache()`           | `LRUCache \| undefined` | Underlying `lru-cache` for this namespace. **Primary only**.                            |
| `ready`                | `Promise<void>`         | Resolves once worker init has been dispatched. Useful for ordering before the first op. |
| `max(value?)`          | `Promise<number>`       | Getter and setter.                                                                      |
| `ttl(value?)`          | `Promise<number>`       | Getter and setter.                                                                      |
| `allowStale(value?)`   | `Promise<boolean>`      | Getter and setter.                                                                      |

## `wrap` — codec / compression

`wrap(cache, codec)` returns a typed view where values pass through an `encode` / `decode` pair on the way in and out. Use it for compression (gzip, brotli), serialization (MessagePack), or any custom symmetric transform. The library stays codec-agnostic — bring your own.

```ts
import { gzipSync, gunzipSync } from 'node:zlib';
import { ClusterCache, wrap } from 'lru-cache-for-clusters-as-promised';

const inner = new ClusterCache<string, Buffer>({ namespace: 'big-blobs', max: 1000 });

const cache = wrap(inner, {
  encode: (v: unknown) => gzipSync(Buffer.from(JSON.stringify(v), 'utf8')),
  decode: (raw: Buffer) => JSON.parse(gunzipSync(raw).toString('utf8')),
});

await cache.set('user:42', { id: 42, name: 'ada' });
await cache.get('user:42'); // decoded back to { id: 42, name: 'ada' }
```

`encode` and `decode` may be sync or async. The wrapped surface covers value-touching ops (`get`, `set`, `setIfAbsent`, `peek`, `mGet`, `mSet`, `values`, `entries`, async iteration, `fetch`) plus the lifecycle and metric pass-throughs (`has`, `delete`, `keys`, `size`, `clear`, `purgeStale`, `getRemainingTTL`, `stats`).

`incr` / `decr` and `dump` / `load` are not wrapped — they speak in numbers or the raw stored form. Reach them via `wrapped.cache` if you need them.

## `memoize` helper

Cache-aside in one line. Concurrent calls for the same key dedupe to a single underlying invocation _within the same worker_.

```ts
import { ClusterCache, memoize } from 'lru-cache-for-clusters-as-promised';

const cache = new ClusterCache<string, User>({ namespace: 'users', ttl: 60_000 });

const getUser = memoize(
  cache,
  (id: string) => fetchUserFromDB(id),
  (id) => `user:${id}`,
  { ttl: 60_000 },
);

await getUser('42'); // first call: hits DB
await getUser('42'); // second call: cached
```

### Per-worker dedup

Both `memoize()` and `cache.fetch()` dedupe concurrent calls inside a single worker. They do **not** coordinate across workers. Two workers racing on the same missing key may both invoke `fetcher` — the cache itself stays consistent (last-write-wins on the primary), but the underlying call may run more than once across the cluster.

If at-most-once invocation is required (expensive APIs, paid endpoints, side effects), your `fetcher` needs its own coordination — e.g. a primary-side lock or a dedicated single-flight worker.

## Errors

**Worker mode.** When a primary-side handler throws, the worker's promise rejects with a reconstructed `Error` carrying the original `name`, `message`, `code`, `stack`, and `cause` chain. The rejected value is always a plain `Error` (subclass identity isn't crossed over IPC), but `.name`, `.code`, and `.cause` are intact, so logging and cause-chain walking work. Errors travel as `{ name, message, code?, stack?, cause? }` on the wire.

**Primary mode.** No IPC: a thrown `Error` rejects as-is (subclass identity preserved); a thrown non-`Error` value is wrapped in `new Error(String(value))`. For `Error` throws the two modes are observably equivalent.

## Migrating from v1.x

The v2 API mirrors `lru-cache@11`. Common renames:

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

```sh
DEBUG=lru-cache-for-clusters-as-promised-* node app.js
```

Available namespaces:

- `lru-cache-for-clusters-as-promised-primary` — cache creation, registry events
- `lru-cache-for-clusters-as-promised-messages` — every request/response over IPC

## License

MIT — see [LICENSE](./LICENSE).
