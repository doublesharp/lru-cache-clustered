<p align="center">
  <img src="https://raw.githubusercontent.com/doublesharp/lru-cache-clustered/main/assets/LRUCacheClustered.png" alt="A pika, the project mascot" width="180" height="180">
</p>

# @0xdoublesharp/lru-cache-clustered

[![npm](https://img.shields.io/npm/v/%400xdoublesharp%2Flru-cache-clustered.svg)](https://www.npmjs.com/package/@0xdoublesharp/lru-cache-clustered)
[![CI](https://github.com/doublesharp/lru-cache-clustered/actions/workflows/ci.yml/badge.svg)](https://github.com/doublesharp/lru-cache-clustered/actions/workflows/ci.yml)
[![Coverage](https://codecov.io/gh/doublesharp/lru-cache-clustered/branch/main/graph/badge.svg)](https://codecov.io/gh/doublesharp/lru-cache-clustered)
[![Downloads](https://img.shields.io/npm/dt/%400xdoublesharp%2Flru-cache-clustered.svg)](https://www.npmjs.com/package/@0xdoublesharp/lru-cache-clustered)

Let your Node.js workers share what they have already learned. When one worker caches a database result, the others can reuse it instead of loading and storing their own copies.

This package keeps namespaced [LRU caches](https://github.com/isaacs/node-lru-cache) in a Node.js cluster's primary process. LRU means least recently used: when the cache fills up, it removes the entries you have used least recently. Workers access the shared cache through an asynchronous API over inter-process communication, or IPC. Atomic counters and fetch coordination also run in the primary.

No separate cache service is required. The shared data lives in memory for the lifetime of the primary process. Optional local L1 caches keep hot values inside individual workers to avoid repeated IPC reads.

<p align="center">
  <img src="https://raw.githubusercontent.com/doublesharp/lru-cache-clustered/main/assets/topology.svg" alt="The primary owns shared namespaced caches. Workers read and write through IPC, with optional local caches and invalidation messages." width="100%">
</p>

## What you get

Each worker can reuse the same cached data, take a turn loading a missing value, and update shared counters without racing another worker.

| Capability             | How it works                                                                                     |
| ---------------------- | ------------------------------------------------------------------------------------------------ |
| Shared cache storage   | One primary-owned cache per namespace, with optional extra copies in worker L1 caches.           |
| Shared warm entries    | A value loaded by one worker becomes available to the others.                                    |
| Atomic counters        | `incr()` and `decr()` execute in the primary; later increments preserve the original expiration. |
| Coordinated loading    | `fetch()` and `memoize()` coordinate concurrent misses for a key through a primary-owned claim.  |
| Temporary claims       | `setIfAbsent()` atomically claims a key while it remains cached.                                 |
| Optional local reads   | L1 can serve repeated reads without IPC, with eventual consistency.                              |
| Compression and codecs | `wrap()` converts values on writes and reads through your encoder and decoder.                   |
| Metrics and errors     | Namespace statistics, local L1 statistics, and structured IPC errors.                            |

## Install

Install this package and the cache engine it uses. Both JavaScript and TypeScript applications can use it.

```sh
npm install @0xdoublesharp/lru-cache-clustered lru-cache@^11
```

For pnpm or Yarn, use `pnpm add` or `yarn add` with the same package names. `lru-cache` is a peer dependency, so your application controls its installed version within the supported range.

Requires Node.js 22 or newer. Includes ESM and CommonJS builds and TypeScript declarations.

> `@0xdoublesharp/lru-cache-clustered` is the canonical package name. `lru-cache-for-clusters-as-promised` is published from the same build at the same version.

## Quick start

Start a few workers and give their caches the same name. A write from any worker goes into the shared cache in the primary.

Save this as `app.mjs` and run `node app.mjs` after installing the packages:

```js
import cluster from 'node:cluster';
import { LRUCacheClustered } from '@0xdoublesharp/lru-cache-clustered';

LRUCacheClustered.bootstrap();

const options = {
  namespace: 'greetings',
  max: 1000,
  ttl: 60_000,
  failsafe: 'reject',
};

if (cluster.isPrimary) {
  const cache = await LRUCacheClustered.getInstance(options);
  await cache.set('hello', 'Hello from the shared cache');
  cluster.fork();
  cluster.fork();
} else {
  const cache = await LRUCacheClustered.getInstance(options);
  console.log(`Worker ${cluster.worker.id}: ${await cache.get('hello')}`);
  process.disconnect();
}
```

Both workers read the same entry. `getInstance()` waits for namespace registration and rejects if initialization fails. Reuse the returned instance in each process, especially with L1 enabled.

Import the package in the primary before `cluster.fork()`. The import installs the IPC listener; `bootstrap()` makes that setup explicit. Instances that share a namespace must agree on primary cache options such as `max` and `ttl`.

## Use cases

Use it when several workers in one Node.js cluster need the same temporary data. The most useful patterns save repeated work or coordinate short-lived state.

| Idea                                                              | Pattern                                                                                                          | Example                                                                     |
| ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| Stop a popular profile from triggering duplicate database queries | `memoize()` or `fetch()` lets workers reuse a cached result and coordinate concurrent misses.                    | [User lookup server](./examples/clustered-users-server.ts)                  |
| Limit API requests across workers                                 | `incr()` updates one shared counter. Its first write starts the TTL window; later increments keep that deadline. | [Rate limiter](./examples/clustered-rate-limit-server.ts)                   |
| Share temporary session data                                      | `set()`, `get()`, and `delete()` share entries across workers. Keep durable session state elsewhere.             | [Session server](./examples/clustered-session-server.ts)                    |
| Suppress repeated job submissions                                 | `setIfAbsent()` lets one worker claim a cached key. Expiration, eviction, or restart can allow another claim.    | [Idempotent intake](./examples/clustered-idempotency-server.ts)             |
| Keep large generated documents in less cache space                | `wrap()` compresses stored values and decodes them on reads.                                                     | [Compressed documents](./examples/clustered-compressed-documents-server.ts) |
| Reduce repeated Redis reads                                       | Use this shared cache in front of Redis, then add a small worker L1 for hot reads.                               | [Multilayer cache](./examples/clustered-multilayer-redis-server.ts)         |

For example, a report endpoint can use the report parameters as a cache key and `fetch()` to coordinate generation. Include tenant and authorization context when they affect the result.

The cache belongs to one primary process. Separate clusters, containers, and machines do not share it. Use a remote cache or database when you need that wider scope, durable state, or coordination that must survive eviction and restarts. Shared counters and claims are atomic while their keys remain present; they do not provide durable quotas or exactly-once job processing.

Namespaces separate application data by name. They do not restrict worker access, so all workers must be trusted.

## Runnable examples

Start an example server, send it requests, and watch workers share cached results. The [example guide](./examples/README.md) has curl commands, ports, and environment settings.

| Command                    | What to explore                                                                      |
| -------------------------- | ------------------------------------------------------------------------------------ |
| `pnpm example:users`       | Shared read-through user cache with `memoize()` and `fetch()`.                       |
| `pnpm example:rate-limit`  | Fixed-window counters across workers.                                                |
| `pnpm example:sessions`    | Shared session reads and writes.                                                     |
| `pnpm example:idempotency` | Temporary job claims with `setIfAbsent()`.                                           |
| `pnpm example:documents`   | Compression with `wrap()`.                                                           |
| `pnpm example:l1`          | Method filtering, bypass reads, local invalidation, and write-through L1 population. |
| `pnpm example:multilayer`  | Shared memory caching in front of Redis. Requires Redis.                             |

The [basic L1 server](./examples/clustered-l1-server.ts) can also run with `node --import tsx examples/clustered-l1-server.ts`.

## Local L1 mode

Keep a small copy of frequently read values inside each worker. Repeated reads can stay in that worker instead of asking the primary again.

Enable the optional L1 cache with `localL1`. The primary remains the source of truth and owns every write. Invalidation messages tell workers to drop local entries after changes, but delivery is asynchronous.

```ts
type Product = { sku: string; name: string };

const products = new LRUCacheClustered<string, Product>({
  namespace: 'products',
  max: 25_000,
  ttl: 60_000,
  localL1: { enabled: true, experimental: true, ttl: 2_000 },
});
```

> L1 improves repeated read latency by avoiding IPC, but it can briefly serve stale data. Keep L1 TTL short and bypass L1 for correctness-sensitive reads.

Set `experimental: true` to opt in. Without an explicit local TTL, the default is 10% of a positive primary TTL, up to 5 seconds, with a 100 ms floor. With no primary expiration, including `ttl: 0`, it defaults to 5 seconds. Each local entry is also capped at the remaining lifetime reported by the primary.

Reuse one cache instance per namespace in each worker. Each constructor or `getInstance()` call creates a separate local L1, so recreating the instance per request loses its warm entries.

A cold `fetch()` claims the key and stores the result in two IPC requests. Followers poll the claim once per cycle and reuse the leader's result.

L1 misses receive values and remaining TTLs in one primary response. A cold `mGet()` uses one IPC request for the batch, and a fully warm batch uses none. Local hits cannot extend an entry past the primary expiration recorded in that response, even with `updateAgeOnGet` or `allowStale` enabled.

Read paths can bypass L1 per call:

```ts
await products.get('sku:123', { bypassL1: true });
await products.mGet(['sku:123', 'sku:456'], { bypassL1: true });
await products.fetch('sku:789', loadProduct, { ttl: 60_000, bypassL1: true });
```

For a reusable fresh-read view, use `withoutLocal()`:

```ts
const freshProducts = products.withoutLocal();
await freshProducts.get('sku:123'); // always goes to the primary
```

Local controls and metrics:

| Method                   | Description                                                                                              |
| ------------------------ | -------------------------------------------------------------------------------------------------------- |
| `localStats()`           | Returns `{ enabled, hits, misses, sets, invalidations, evictions, staleHits, size, ipcAvoided }`.        |
| `clearLocal()`           | Flushes this instance's local L1 without touching the primary cache.                                     |
| `invalidateLocal(key)`   | Drops one local L1 key without touching the primary cache.                                               |
| `withoutLocal()`         | Returns a read-through-primary wrapper over the same cache instance.                                     |
| `on(event, listener)`    | Subscribes to L1 events: `l1:hit`, `l1:miss`, `l1:set`, `l1:invalidate`, `l1:evict`, and `l1:stale-hit`. |
| `off(...)` / `once(...)` | Standard event listener helpers.                                                                         |

`localL1.methods` can restrict which read families use L1:

```ts
localL1: {
  enabled: true,
  experimental: true,
  methods: { get: true, has: false, fetch: true },
}
```

When `methods` is provided, omitted method keys are disabled. `memoize()` delegates to `fetch()`, so its L1 behavior follows the `fetch` setting.

By default, same-process and cross-worker writes broadcast invalidations so hot local entries are dropped before their TTL expires. If you intentionally want TTL-only consistency, set `localL1.invalidation: 'ttl-only'`.

See [`docs/l1.md`](docs/l1.md) for the full consistency model, stats, events, method options, and failure modes.

## How it works

Think of the primary as a shared cupboard and the workers as people borrowing from it. A namespace names one cupboard. Workers with the same namespace share its contents.

`new LRUCacheClustered(...)` branches at construction:

- **In the primary** (`cluster.isPrimary === true`), the instance owns and operates on the in-process `LRUCache` for its namespace directly, without IPC.
- **In a worker**, every operation becomes a typed IPC request to the primary; the returned Promise resolves with the response.

Instances in different workers that share a `namespace` operate on the same primary-side cache. Those instances should agree on cache options (`max`, `ttl`, `allowStale`, ...): reusing a namespace with conflicting options throws rather than silently keeping whichever process initialized it first.

> **Initialization semantics.** In a worker, `new LRUCacheClustered(...)` eagerly sends the `init` message, but `cache.ready` is ordering-only and intentionally swallows init failure. Use `await cache.healthCheck()` or `await LRUCacheClustered.getInstance(...)` when startup should fail fast if the primary cannot register the namespace.

## Performance profile

Sharing saves duplicate cache storage, but asking another process for a value takes time. A small local cache can speed up repeated reads, at the cost of extra copies and a brief stale-data window.

| Read path               | Cost and behavior                                                                                            |
| ----------------------- | ------------------------------------------------------------------------------------------------------------ |
| Primary process         | Dispatches to the local `lru-cache` without IPC.                                                             |
| Worker without L1       | Reads and writes use IPC. A cache hit still crosses processes.                                               |
| Worker with L1          | Eligible local hits avoid IPC; misses and writes reach the primary.                                          |
| Concurrent cache misses | One leader runs the fetcher while followers poll for the result, subject to claim expiry and forced refresh. |

Use this package when sharing cached data is worth the IPC cost. Use plain per-process `lru-cache` when worker independence and the lowest local read latency matter more. Benchmark with your payload sizes, worker count, and read/write mix using `pnpm bench`.

## Options

Choose how much the cache can hold and how long values stay fresh. `max` limits the number of entries; `ttl`, or time to live, sets their lifetime in milliseconds.

The serializable subset of [`lru-cache`](https://github.com/isaacs/node-lru-cache) constructor options passes through (`max`, `maxSize`, `maxEntrySize`, `ttl`, `allowStale`, `updateAgeOnGet`, `updateAgeOnHas`, `noDeleteOnStaleGet`, `ttlAutopurge`). Plus:

| Option      | Type                      | Default     | Description                                                                                                   |
| ----------- | ------------------------- | ----------- | ------------------------------------------------------------------------------------------------------------- |
| `namespace` | `string`                  | `'default'` | Logical name. Instances sharing a namespace share state on the primary.                                       |
| `timeout`   | `number`                  | `100`       | Worker IPC timeout in ms.                                                                                     |
| `failsafe`  | `'resolve' \| 'reject'`   | `'resolve'` | On worker IPC timeout: `'resolve'` resolves with `undefined`; `'reject'` rejects with `Error('IPC timeout')`. |
| `localL1`   | `false \| LocalL1Options` | `undefined` | Optional local hot-read cache. Pass `{ enabled: true, experimental: true }` to opt in.                        |

`LocalL1Options`:

| Option           | Type                        | Default       | Description                                                                                                            |
| ---------------- | --------------------------- | ------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `enabled`        | `boolean`                   | `true`        | Set `false` to disable when an options object is reused.                                                               |
| `experimental`   | `boolean`                   | required      | Must be `true` to opt in to eventual consistency.                                                                      |
| `max`            | `number`                    | `1000`        | Maximum local entries per instance.                                                                                    |
| `maxSize`        | `number`                    | `undefined`   | Optional local size bound. Uses one size unit per entry.                                                               |
| `ttl`            | `number`                    | derived       | Local TTL in ms, capped by primary TTL and per-entry remaining TTL.                                                    |
| `updateAgeOnGet` | `boolean`                   | `true`        | Passed to the local `lru-cache`.                                                                                       |
| `allowStale`     | `boolean`                   | `false`       | Passed to the local `lru-cache`; Stale returns and rejected expired/version-stale local entries increment `staleHits`. |
| `invalidation`   | `'broadcast' \| 'ttl-only'` | `'broadcast'` | Whether this instance subscribes to local/IPC invalidation pushes or relies only on local TTL expiry.                  |
| `methods`        | `{ get?, has?, fetch? }`    | all enabled   | Restrict which read families use L1. If present, omitted keys are disabled.                                            |
| `cacheUndefined` | `boolean`                   | unsupported   | Reserved for future negative-result caching; currently forced off.                                                     |

Function-valued `lru-cache` options such as `dispose`, `disposeAfter`, `sizeCalculation`, or `fetchMethod` do not cross IPC and are not supported by this wrapper.

> **`failsafe: 'resolve'` caveat.** Most single-result operations return `undefined` on an IPC timeout with `'resolve'`, even when their declared return type differs. `mGet()` can return an empty or partial map. `fetch()`, `getInstance()`, and `healthCheck()` reject on IPC timeouts. For `get` / `peek` that is natural; for `has` / `set` / `delete` / `incr` / `decr` / `size` it can surprise callers (`undefined + 1 === NaN`). Use `'reject'` if typed-shape correctness on timeout matters.

> **Size-bounded caches.** When you use `maxSize` or `maxEntrySize`, provide `size` on every write path (`set`, `setIfAbsent`, `mSet`, `fetch`, `memoize`, and the first `incr` / `decr` for a counter key). `sizeCalculation` does not cross IPC, so the primary cannot infer it for you.

> **Fail-fast startup.** `LRUCacheClustered.getInstance()` and `cache.healthCheck()` always reject if the primary cannot answer, regardless of `failsafe`, so you can use them as hard startup checks.

> **Key/value contract.** Like `lru-cache`, keys and values must be non-nullish. Passing `null` or `undefined` rejects. Use string keys across workers: IPC copies object keys, so object identity cannot be shared between processes.

## API

The same methods work in the primary and in workers. Await shared-cache operations; local-cache controls run immediately in the calling process.

### Static

These helpers set up the shared cache before you start using it.

| Method                                   | Description                                                                                                                                                                      |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `LRUCacheClustered.bootstrap()`          | Installs the primary-side cluster listener immediately. Useful when you want an explicit bootstrap call instead of relying on module import side effects.                        |
| `LRUCacheClustered.getInstance(options)` | Async factory. In a worker, awaits the init message so the primary has registered the namespace before returning. Preferred when worker startup should fail fast on init errors. |
| `LRUCacheClustered.getAllCaches()`       | Returns the `Map<namespace, LRUCache>` registry. Primary only; throws in workers.                                                                                                |

### Core

Store a value, read it back, check whether it exists, or remove it.

| Method                                        | Returns                   | Notes                                                          |
| --------------------------------------------- | ------------------------- | -------------------------------------------------------------- |
| `get(key, { bypassL1? })`                     | `Promise<V \| undefined>` |                                                                |
| `set(key, value, { ttl?, size?, updateL1? })` | `Promise<boolean>`        | `updateL1` populates the caller's L1 after a successful write. |
| `setIfAbsent(key, value, { ttl?, size? })`    | `Promise<boolean>`        | Atomic on the primary. `false` if the key already exists.      |
| `delete(key)`                                 | `Promise<boolean>`        |                                                                |
| `has(key, { bypassL1? })`                     | `Promise<boolean>`        |                                                                |
| `peek(key, { bypassL1? })`                    | `Promise<V \| undefined>` | Does not update LRU position.                                  |
| `clear()`                                     | `Promise<void>`           | Clears the primary cache and this instance's L1.               |

### Multi

Handle several keys in one call to avoid a separate trip to the primary for every key. Batch writes are not transactions; a later failure can leave earlier writes applied.

| Method                           | Returns                           | Notes                                                                                                            |
| -------------------------------- | --------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `mGet(keys, { bypassL1? })`      | `Promise<Map<K, V \| undefined>>` | Preserves input key order even when L1 partially hits.                                                           |
| `mSet(entries, { ttl?, size? })` | `Promise<void>`                   | `entries: Iterable<[K, V] \| [K, V, { ttl?, size? }]>`; outer opts apply as defaults. Clears this instance's L1. |
| `mDelete(keys)`                  | `Promise<void>`                   |                                                                                                                  |

### Enumeration

Inspect the contents or take a snapshot for later restoration. These methods return whole collections, so large caches create large responses.

| Method                     | Returns                         | Notes                                                           |
| -------------------------- | ------------------------------- | --------------------------------------------------------------- |
| `keys()`                   | `Promise<K[]>`                  | Most recently used first.                                       |
| `values()`                 | `Promise<V[]>`                  | Most recently used first.                                       |
| `entries()`                | `Promise<[K, V][]>`             | Most recently used first.                                       |
| `[Symbol.asyncIterator]()` | `AsyncIterableIterator<[K, V]>` | `for await (const [k, v] of cache)`. Materializes the full set. |
| `dump()`                   | `Promise<[K, Entry][]>`         | Serializable snapshot.                                          |
| `load(entries)`            | `Promise<void>`                 | Restores from a `dump()`, preserving per-entry TTL metadata.    |
| `size()`                   | `Promise<number>`               |                                                                 |

### Counters and cache-aside

Count events without workers overwriting each other, or load a missing value once and share the result. Cache-aside means checking the cache before doing the expensive work.

| Method                                                           | Returns                | Notes                                                                                                              |
| ---------------------------------------------------------------- | ---------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `incr(key, amount?, { ttl?, size? })`                            | `Promise<number>`      | Atomic on the primary. `ttl` is set on the **first** write only; later increments do not reset it (rate limiters). |
| `decr(key, amount?, { ttl?, size? })`                            | `Promise<number>`      | Same.                                                                                                              |
| `fetch(key, fetcher, { ttl?, size?, forceRefresh?, bypassL1? })` | `Promise<V>`           | Cache-aside with cluster-wide single-flight semantics. See [Single-flight semantics](#single-flight-semantics).    |
| `memoize(cache, fn, keyFn, opts?)`                               | `(args) => Promise<V>` | Top-level helper. Single-flight via `cache.fetch()`. See [`memoize` helper](#memoize-helper).                      |

### Local L1

These controls affect the extra cache inside this process. They help you see whether local reads are saving trips to the primary.

| Method / event                                    | Returns / payload         | Notes                                                                                    |
| ------------------------------------------------- | ------------------------- | ---------------------------------------------------------------------------------------- |
| `localStats()`                                    | `L1Stats \| undefined`    | `undefined` when local L1 is disabled.                                                   |
| `clearLocal()`                                    | `void`                    | Local-only flush.                                                                        |
| `invalidateLocal(key)`                            | `void`                    | Local-only single-key invalidation.                                                      |
| `withoutLocal()`                                  | `LRUCacheClustered<K, V>` | Bypass view for `get`, `has`, `peek`, `mGet`, and `fetch`; writes pass through normally. |
| `on('l1:hit' \| 'l1:miss' \| 'l1:set', listener)` | `{ namespace, key }`      | Key is the original cache key, not an internal encoded key.                              |
| `on('l1:invalidate', listener)`                   | `{ namespace, key }`      | `key` may be `'*'` for namespace-wide invalidation.                                      |
| `on('l1:evict' \| 'l1:stale-hit', listener)`      | `{ namespace, key }`      | `stale-hit` also fires when an expired or version-stale local entry is rejected.         |
| `off(event, listener)` / `once(event, listener)`  | `this`                    | Standard event helpers.                                                                  |

### Lifecycle, metrics, tunables

Check the cache, inspect its activity, change its limits, or remove its namespace.

| Method                 | Returns                 | Notes                                                                                                                                           |
| ---------------------- | ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `getRemainingTTL(key)` | `Promise<number>`       | ms until expiry. `Infinity` for keys with no TTL; `0` for missing keys.                                                                         |
| `purgeStale()`         | `Promise<boolean>`      | Removes expired entries.                                                                                                                        |
| `healthCheck()`        | `Promise<void>`         | Verifies that the primary can resolve the namespace and answer requests.                                                                        |
| `stats()`              | `Promise<Stats>`        | `{ hits, misses, sets, deletes, evictions, size, namespace }`.                                                                                  |
| `destroy()`            | `Promise<boolean>`      | Removes the namespace cache, stats, and primary-side coordination state. Later use of the same instance recreates it with the original options. |
| `getCache()`           | `LRUCache \| undefined` | Underlying `lru-cache` for this namespace. **Primary only**.                                                                                    |
| `ready`                | `Promise<void>`         | Waits for worker initialization but swallows failures. Use `getInstance()` when initialization errors should reject.                            |
| `max(value?)`          | `Promise<number>`       | Getter and setter. Setter preserves primary entries and remaining TTL metadata, then clears this instance's L1.                                 |
| `ttl(value?)`          | `Promise<number>`       | Getter and setter. Setter clears this instance's L1.                                                                                            |
| `allowStale(value?)`   | `Promise<boolean>`      | Getter and setter.                                                                                                                              |

## Compression and codecs

Large documents take less cache space when compressed. A codec converts values before storage and converts them back when you read them.

`wrap(cache, codec)` returns a typed view where values pass through an `encode` / `decode` pair on the way in and out. Use it for compression (gzip, brotli), serialization (MessagePack), or any custom symmetric transform. Supply the codec that fits your data.

```ts
import { gzipSync, gunzipSync } from 'node:zlib';
import { LRUCacheClustered, wrap } from '@0xdoublesharp/lru-cache-clustered';

// Encode to a string (base64 here) so the wire format is Buffer-safe in workers.
// See the Buffer caveat below.
const inner = new LRUCacheClustered<string, string>({ namespace: 'big-blobs', max: 1000 });

const cache = wrap(inner, {
  encode: (v: unknown) => gzipSync(Buffer.from(JSON.stringify(v), 'utf8')).toString('base64'),
  decode: (raw: string) => JSON.parse(gunzipSync(Buffer.from(raw, 'base64')).toString('utf8')),
});

await cache.set('user:42', { id: 42, name: 'ada' });
await cache.get('user:42'); // decoded back to { id: 42, name: 'ada' }
```

`encode` and `decode` may be sync or async. The wrapper encodes or decodes values for (`get`, `set`, `setIfAbsent`, `peek`, `mGet`, `mSet`, `values`, `entries`, async iteration, `fetch`) and forwards lifecycle and metric methods (`has`, `delete`, `keys`, `size`, `clear`, `destroy`, `healthCheck`, `purgeStale`, `getRemainingTTL`, `stats`). Wrapped `get`, `has`, `peek`, `mGet`, and `fetch` forward read options such as `{ bypassL1: true }` to the underlying cache.

`incr()` and `decr()` operate on numbers. `dump()` and `load()` operate on raw stored values. The wrapper does not expose those methods. Reach them via `wrapped.cache` if you need them.

> **Binary values.** Default cluster IPC uses JSON serialization and turns a `Buffer` into `{ type: 'Buffer', data: number[] }`. Encode to base64 or rehydrate it in `decode`. If you control cluster setup, `cluster.setupPrimary({ serialization: 'advanced' })` preserves buffers and other supported built-in types. Configure it before forking workers.

## `memoize` helper

Give a function a memory. Calling it again with the same cache key can reuse the previous result instead of repeating a database query or API request.

`memoize(cache, fn, keyFn, opts)` calls `cache.fetch()` under the hood. `keyFn` must include every input that can change the result, including tenant or permission context when relevant.

```ts
import { LRUCacheClustered, memoize } from '@0xdoublesharp/lru-cache-clustered';

type User = { id: string; name: string };

// fetchUserFromDB is your application's database lookup.
const cache = new LRUCacheClustered<string, User>({ namespace: 'users', max: 1000, ttl: 60_000 });

const getUser = memoize(
  cache,
  (id: string) => fetchUserFromDB(id),
  (id) => `user:${id}`,
  { ttl: 60_000 },
);

await getUser('42'); // first call: hits DB
await getUser('42'); // second call: cached
```

### Single-flight semantics

If several workers ask for the same missing value, one does the work while the others wait. This reduces duplicate requests to your database or upstream API.

Both `memoize()` and `cache.fetch()` coordinate through the primary so concurrent misses for the same key collapse to one in-flight fetch across instances and workers.

Passing `forceRefresh: true` skips both the cache lookup and any in-flight claim and starts a fresh leader fetch. On a cache miss, concurrent callers without `forceRefresh` wait on the current fetch and reuse its result. During a forced refresh, other instances can still read an existing cached value until the refresh finishes. Passing `bypassL1: true` skips local L1 reads and population for that call while preserving the primary-side single-flight behavior.

A fetch claim has a 30-second lease. A later caller can take over an expired claim, and a worker exit releases its claims. Fetchers must tolerate duplicate execution after a lease expires or a forced refresh replaces a claim.

The cache `timeout` option only bounds each worker IPC request. It does not cancel user fetcher work after a worker owns the primary-side single-flight lock, so production fetchers should enforce their own upstream timeout or abort policy.

## Errors

A missing key is normal. A failed operation is different: handle its rejected promise, and choose whether an IPC timeout should reject or return `undefined`.

**Worker mode.** When a primary-side handler throws, the worker's promise rejects with a reconstructed `Error` carrying the original `name`, `message`, `code`, `stack`, and `cause` chain. The rejected value is always a plain `Error` (IPC does not preserve subclass identity), but `.name`, `.code`, and `.cause` are intact, so logging and cause-chain walking work. Errors travel as `{ name, message, code?, stack?, cause? }` on the wire.

**Primary mode.** No IPC: a thrown `Error` rejects as-is (subclass identity preserved); a thrown non-`Error` value is wrapped in `new Error(String(value))`. Custom error subclasses retain their identity only in primary mode.

## Debugging

Turn on logs to see whether workers are reaching the primary and which requests they send.

```sh
DEBUG=lru-cache-clustered-* node app.js
```

Available namespaces:

- `lru-cache-clustered-primary` logs cache creation and registry events.
- `lru-cache-clustered-messages` logs IPC requests and responses.

## Migration

Existing applications can move to the scoped package name while keeping the compatibility alias during the transition.

`LRUCacheClustered` is the canonical class; `LRUCacheForClustersAsPromised` remains an alias. The [migration guide](./docs/migration.md) maps the older methods, options, and package name. The [changelog](./CHANGELOG.md) records release-specific changes.

## Development

Clone the project, install its dependencies, and run the checks before changing code. The examples are small servers you can use to explore the behavior yourself.

For development, use a current Node.js 22 LTS patch release, at least 22.13, or Node.js 24 LTS. Use the pnpm version recorded in `package.json`; the runtime minimum for applications remains Node.js 22.

```sh
git clone https://github.com/doublesharp/lru-cache-clustered.git
cd lru-cache-clustered
corepack enable
pnpm install --frozen-lockfile
pnpm check
```

| Command              | What it does                                                                              |
| -------------------- | ----------------------------------------------------------------------------------------- |
| `pnpm check`         | Lint, typecheck, tests, unused-code checks, type coverage, build, and bundle-size checks. |
| `pnpm test`          | Unit, fuzz, and real cluster-worker tests.                                                |
| `pnpm test:coverage` | Text and LCOV coverage reports in `coverage/`.                                            |
| `pnpm build`         | ESM and CommonJS bundles with TypeScript declarations in `dist/`.                         |
| `pnpm bench`         | Compare worker reads with and without local L1.                                           |
| `pnpm example:users` | Start the shared user-cache example.                                                      |

`src/primary.ts` owns shared state and executes operations. `src/worker.ts` manages IPC requests and responses. `src/index.ts` exposes the public API and connects it to `src/l1.ts`. Codec and memoization helpers live in `src/codec.ts` and `src/memoize.ts`.

When changing cache behavior, add a regression test that retains the same cache instances and checks the resulting values. For L1 changes, verify warm hits, invalidation, and expiration. Cluster tests use child processes under both JSON and advanced serialization.

Dependency resolution waits seven days after publication through `minimumReleaseAge` in `pnpm-workspace.yaml`. Use frozen lockfile installs for reproducible checks. Release preparation with `pnpm prepare:publish` creates scoped and legacy package directories under `dist-publish/`; the [publishing workflow](./.github/workflows/npm-publish.yml) handles publication.

## License

You can use, modify, and distribute this package under the MIT license. See [LICENSE](./LICENSE) for the terms.
