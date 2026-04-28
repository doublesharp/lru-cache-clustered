# lru-cache-for-clusters-as-promised

[![lru-cache-for-clusters-as-promised](https://img.shields.io/npm/v/lru-cache-for-clusters-as-promised.svg)](https://www.npmjs.com/package/lru-cache-for-clusters-as-promised)
[![CI](https://github.com/doublesharp/lru-cache-for-clusters-as-promised/actions/workflows/ci.yml/badge.svg)](https://github.com/doublesharp/lru-cache-for-clusters-as-promised/actions/workflows/ci.yml)
[![codecov](https://codecov.io/gh/doublesharp/lru-cache-for-clusters-as-promised/branch/main/graph/badge.svg)](https://codecov.io/gh/doublesharp/lru-cache-for-clusters-as-promised)
[![Downloads](https://img.shields.io/npm/dt/lru-cache-for-clusters-as-promised.svg)](https://www.npmjs.com/package/lru-cache-for-clusters-as-promised)

**One LRU cache, shared across every worker in your `node:cluster` app.** A typed Promise wrapper around [`lru-cache`](https://www.npmjs.com/package/lru-cache) that lives on the primary process and is reached from workers via IPC — so memory only gets paid once, not per worker. Outside `cluster`, it's a Promise interface to a plain in-process `lru-cache`.

- **One copy in memory** — workers don't each duplicate the cache
- **Race-safe counters** — `incr` / `decr` are atomic on the primary, safe across N workers
- **Cache-aside in one line** — `fetch()` and `memoize()` collapse concurrent misses for the same key across the cluster
- **Codec wrappers** — transparent gzip / MessagePack / custom encode-decode via `wrap()`
- **Per-namespace stats** — hits, misses, sets, deletes, evictions, size
- **TTL with rate-limiter semantics** — `incr` keeps the original expiration ticking
- **Modern** — TypeScript, dual ESM + CJS, Node >=22, structured error transport

> **API shape.** The surface follows modern `lru-cache` conventions. If you're upgrading from an older release line, see [Migrating from older releases](#migrating-from-older-releases).

## Install

`lru-cache` is a peer dependency. Install it alongside this package so you control the version.

```sh
npm install lru-cache-for-clusters-as-promised lru-cache
pnpm add lru-cache-for-clusters-as-promised lru-cache
yarn add lru-cache-for-clusters-as-promised lru-cache
```

## Quick start

```ts
import cluster from 'node:cluster';
import { availableParallelism } from 'node:os';
import { LRUCacheClustered } from 'lru-cache-for-clusters-as-promised';

LRUCacheClustered.bootstrap();

const cache = new LRUCacheClustered<string, string>({
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

> **Naming.** `LRUCacheClustered` is the short alias for `LRUCacheForClustersAsPromised`. The long name remains exported if you prefer the fully explicit class name.

> **Startup ordering.** Import this package in the primary before `cluster.fork()`. The primary-side IPC listener is installed at module import time; if workers send cache requests before that import happens, they will time out. Call `LRUCacheClustered.bootstrap()` if you want that setup to be explicit in application code.

## Examples

Runnable clustered server examples live in [`examples/README.md`](./examples/README.md):

- shared read-through user cache via `memoize()` / `fetch()`
- fixed-window rate limiting via atomic `incr()`
- shared session storage via `set()` / `get()` / `delete()`
- idempotent job intake via `setIfAbsent()`
- compressed document caching via `wrap()`

## How it works

<p align="center">
  <img src="https://raw.githubusercontent.com/doublesharp/lru-cache-for-clusters-as-promised/main/assets/topology.svg" alt="One LRU cache shared across cluster workers via IPC. The primary process holds a Map of namespaced LRUCache instances; each worker sends typed IPC requests to the primary for every cache operation. In primary mode the dispatcher is invoked directly with no IPC." width="100%">
</p>

`new LRUCacheClustered(...)` branches at construction:

- **In the primary** (`cluster.isPrimary === true`), the instance owns and directly operates on the in-process `LRUCache` for its namespace — no IPC, no allocation per call.
- **In a worker**, every operation becomes a typed IPC request to the primary; the returned Promise resolves with the response.

Instances in different workers that share a `namespace` operate on the same primary-side cache. That's where the memory savings come from. Those instances should agree on cache options (`max`, `ttl`, `allowStale`, ...): reusing a namespace with conflicting options throws rather than silently keeping whichever process initialized it first.

> **Initialization semantics.** In a worker, `new LRUCacheClustered(...)` eagerly sends the `init` message, but `cache.ready` is ordering-only and intentionally swallows init failure. Use `await cache.healthCheck()` or `await LRUCacheClustered.getInstance(...)` when startup should fail fast if the primary cannot register the namespace.

## Performance profile

- **Primary mode** — operations dispatch directly to the local `lru-cache` instance.
- **Worker mode** — every cache operation is an IPC round trip through the primary.
- **Hot misses** — `fetch()` and `memoize()` collapse concurrent misses for the same key across workers.
- **Design tradeoff** — use this package when cross-worker sharing and single-copy memory matter more than per-call latency; use plain per-process `lru-cache` when your hottest path cannot afford the IPC hop.

## Options

The serializable subset of [`lru-cache`](https://github.com/isaacs/node-lru-cache) constructor options passes through (`max`, `maxSize`, `maxEntrySize`, `ttl`, `allowStale`, `updateAgeOnGet`, `updateAgeOnHas`, `noDeleteOnStaleGet`, `ttlAutopurge`). Plus:

| Option      | Type                    | Default     | Description                                                                                                   |
| ----------- | ----------------------- | ----------- | ------------------------------------------------------------------------------------------------------------- |
| `namespace` | `string`                | `'default'` | Logical name. Instances sharing a namespace share state on the primary.                                       |
| `timeout`   | `number`                | `100`       | Worker IPC timeout in ms.                                                                                     |
| `failsafe`  | `'resolve' \| 'reject'` | `'resolve'` | On worker IPC timeout: `'resolve'` resolves with `undefined`; `'reject'` rejects with `Error('IPC timeout')`. |

Function-valued `lru-cache` options such as `dispose`, `disposeAfter`, `sizeCalculation`, or `fetchMethod` do not cross IPC and are not supported by this wrapper.

> **`failsafe: 'resolve'` caveat.** On timeout, `'resolve'` returns `undefined` for _every_ op, regardless of declared return type. For `get` / `peek` that's natural; for `has` / `set` / `delete` / `incr` / `decr` / `size` it can surprise callers (`undefined + 1 === NaN`). Use `'reject'` if typed-shape correctness on timeout matters.

> **Size-bounded caches.** When you use `maxSize` or `maxEntrySize`, provide `size` on every write path (`set`, `setIfAbsent`, `mSet`, `fetch`, `memoize`, and the first `incr` / `decr` for a counter key). `sizeCalculation` does not cross IPC, so the primary cannot infer it for you.

> **Fail-fast startup.** `LRUCacheClustered.getInstance()` and `cache.healthCheck()` always reject if the primary cannot answer, regardless of `failsafe`, so you can use them as hard startup checks.

> **Key/value contract.** Like `lru-cache`, keys and values must be non-nullish. Passing `null` or `undefined` rejects instead of relying on ambiguous cache semantics.

## API

### Static

| Method                                   | Description                                                                                                                                                                      |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `LRUCacheClustered.bootstrap()`          | Installs the primary-side cluster listener immediately. Useful when you want an explicit bootstrap call instead of relying on module import side effects.                        |
| `LRUCacheClustered.getInstance(options)` | Async factory. In a worker, awaits the init message so the primary has registered the namespace before returning. Preferred when worker startup should fail fast on init errors. |
| `LRUCacheClustered.getAllCaches()`       | Returns the `Map<namespace, LRUCache>` registry. **Primary only** — throws in workers.                                                                                           |

### Core

| Method                                     | Returns                   | Notes                                                     |
| ------------------------------------------ | ------------------------- | --------------------------------------------------------- |
| `get(key)`                                 | `Promise<V \| undefined>` |                                                           |
| `set(key, value, { ttl?, size? })`         | `Promise<boolean>`        |                                                           |
| `setIfAbsent(key, value, { ttl?, size? })` | `Promise<boolean>`        | Atomic on the primary. `false` if the key already exists. |
| `delete(key)`                              | `Promise<boolean>`        |                                                           |
| `has(key)`                                 | `Promise<boolean>`        |                                                           |
| `peek(key)`                                | `Promise<V \| undefined>` | Doesn't update LRU position.                              |
| `clear()`                                  | `Promise<void>`           |                                                           |

### Multi

| Method                           | Returns                           | Notes                                                                                 |
| -------------------------------- | --------------------------------- | ------------------------------------------------------------------------------------- |
| `mGet(keys)`                     | `Promise<Map<K, V \| undefined>>` |                                                                                       |
| `mSet(entries, { ttl?, size? })` | `Promise<void>`                   | `entries: Iterable<[K, V] \| [K, V, { ttl?, size? }]>`; outer opts apply as defaults. |
| `mDelete(keys)`                  | `Promise<void>`                   |                                                                                       |

### Enumeration

| Method                     | Returns                         | Notes                                                            |
| -------------------------- | ------------------------------- | ---------------------------------------------------------------- |
| `keys()`                   | `Promise<K[]>`                  | MRU first.                                                       |
| `values()`                 | `Promise<V[]>`                  | MRU first.                                                       |
| `entries()`                | `Promise<[K, V][]>`             | MRU first.                                                       |
| `[Symbol.asyncIterator]()` | `AsyncIterableIterator<[K, V]>` | `for await (const [k, v] of cache)` — materializes the full set. |
| `dump()`                   | `Promise<[K, Entry][]>`         | Serializable snapshot.                                           |
| `load(entries)`            | `Promise<void>`                 | Restores from a `dump()`, preserving per-entry TTL metadata.     |
| `size()`                   | `Promise<number>`               |                                                                  |

### Counters & cache-aside

| Method                                               | Returns           | Notes                                                                                                             |
| ---------------------------------------------------- | ----------------- | ----------------------------------------------------------------------------------------------------------------- |
| `incr(key, amount?, { ttl?, size? })`                | `Promise<number>` | Atomic on the primary. `ttl` is set on the **first** write only; later increments don't reset it (rate limiters). |
| `decr(key, amount?, { ttl?, size? })`                | `Promise<number>` | Same.                                                                                                             |
| `fetch(key, fetcher, { ttl?, size?, forceRefresh })` | `Promise<V>`      | Cache-aside with cluster-wide single-flight semantics. See [Single-Flight Semantics](#single-flight-semantics).   |

### Lifecycle, metrics, tunables

| Method                 | Returns                 | Notes                                                                                                                                           |
| ---------------------- | ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `getRemainingTTL(key)` | `Promise<number>`       | ms until expiry. `Infinity` for keys with no TTL; `0` for missing keys.                                                                         |
| `purgeStale()`         | `Promise<boolean>`      | Removes expired entries.                                                                                                                        |
| `healthCheck()`        | `Promise<void>`         | Verifies that the primary can resolve the namespace and answer requests.                                                                        |
| `stats()`              | `Promise<Stats>`        | `{ hits, misses, sets, deletes, evictions, size, namespace }`.                                                                                  |
| `destroy()`            | `Promise<boolean>`      | Removes the namespace cache, stats, and primary-side coordination state. Later use of the same instance recreates it with the original options. |
| `getCache()`           | `LRUCache \| undefined` | Underlying `lru-cache` for this namespace. **Primary only**.                                                                                    |
| `ready`                | `Promise<void>`         | Resolves once worker init has been dispatched. Useful for ordering only; use `getInstance()` if init failures should reject.                    |
| `max(value?)`          | `Promise<number>`       | Getter and setter. Setter preserves entries and remaining TTL metadata.                                                                         |
| `ttl(value?)`          | `Promise<number>`       | Getter and setter.                                                                                                                              |
| `allowStale(value?)`   | `Promise<boolean>`      | Getter and setter.                                                                                                                              |

## `wrap` — codec / compression

`wrap(cache, codec)` returns a typed view where values pass through an `encode` / `decode` pair on the way in and out. Use it for compression (gzip, brotli), serialization (MessagePack), or any custom symmetric transform. The library stays codec-agnostic — bring your own.

```ts
import { gzipSync, gunzipSync } from 'node:zlib';
import { LRUCacheClustered, wrap } from 'lru-cache-for-clusters-as-promised';

const inner = new LRUCacheClustered<string, Buffer>({ namespace: 'big-blobs', max: 1000 });

const cache = wrap(inner, {
  encode: (v: unknown) => gzipSync(Buffer.from(JSON.stringify(v), 'utf8')),
  decode: (raw: Buffer) => JSON.parse(gunzipSync(raw).toString('utf8')),
});

await cache.set('user:42', { id: 42, name: 'ada' });
await cache.get('user:42'); // decoded back to { id: 42, name: 'ada' }
```

`encode` and `decode` may be sync or async. The wrapped surface covers value-touching ops (`get`, `set`, `setIfAbsent`, `peek`, `mGet`, `mSet`, `values`, `entries`, async iteration, `fetch`) plus the lifecycle and metric pass-throughs (`has`, `delete`, `keys`, `size`, `clear`, `destroy`, `healthCheck`, `purgeStale`, `getRemainingTTL`, `stats`).

`incr` / `decr` and `dump` / `load` are not wrapped — they speak in numbers or the raw stored form. Reach them via `wrapped.cache` if you need them.

## `memoize` helper

Cache-aside in one line. Concurrent calls for the same key coordinate through `cache.fetch()` so only one caller does the underlying work at a time.

```ts
import { LRUCacheClustered, memoize } from 'lru-cache-for-clusters-as-promised';

const cache = new LRUCacheClustered<string, User>({ namespace: 'users', ttl: 60_000 });

const getUser = memoize(
  cache,
  (id: string) => fetchUserFromDB(id),
  (id) => `user:${id}`,
  { ttl: 60_000 },
);

await getUser('42'); // first call: hits DB
await getUser('42'); // second call: cached
```

### Single-Flight Semantics

Both `memoize()` and `cache.fetch()` coordinate through the primary so concurrent misses for the same key collapse to one in-flight fetch across instances and workers.

`forceRefresh` still bypasses the cached-value check and the current claim, so it intentionally starts a new leader fetch. Followers wait for a value to appear, then reuse it.

## Errors

**Worker mode.** When a primary-side handler throws, the worker's promise rejects with a reconstructed `Error` carrying the original `name`, `message`, `code`, `stack`, and `cause` chain. The rejected value is always a plain `Error` (subclass identity isn't crossed over IPC), but `.name`, `.code`, and `.cause` are intact, so logging and cause-chain walking work. Errors travel as `{ name, message, code?, stack?, cause? }` on the wire.

**Primary mode.** No IPC: a thrown `Error` rejects as-is (subclass identity preserved); a thrown non-`Error` value is wrapped in `new Error(String(value))`. For `Error` throws the two modes are observably equivalent.

## Migrating from older releases

Common method and option mappings from older releases:

| Older release                    | Current API                                                 |
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
