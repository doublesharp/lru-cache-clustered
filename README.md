<p align="center">
  <img src="https://raw.githubusercontent.com/doublesharp/lru-cache-clustered/main/assets/LRUCacheClustered.png" alt="LRUCacheClustered" width="180" height="180">
</p>

<h1 align="center">@0xdoublesharp/lru-cache-clustered</h1>

<p align="center"><sub>Pikas cache hay for the winter. This package caches everything else.</sub></p>

<p align="center">
  <a href="https://www.npmjs.com/package/@0xdoublesharp/lru-cache-clustered"><img src="https://img.shields.io/npm/v/%400xdoublesharp%2Flru-cache-clustered.svg" alt="npm"></a>
  <a href="https://github.com/doublesharp/lru-cache-clustered/actions/workflows/ci.yml"><img src="https://github.com/doublesharp/lru-cache-clustered/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="https://github.com/doublesharp/lru-cache-clustered/actions/workflows/coverage.yml"><img src="https://github.com/doublesharp/lru-cache-clustered/actions/workflows/coverage.yml/badge.svg" alt="Coverage"></a>
  <a href="https://codecov.io/gh/doublesharp/lru-cache-clustered"><img src="https://codecov.io/gh/doublesharp/lru-cache-clustered/branch/main/graph/badge.svg" alt="codecov"></a>
  <a href="https://www.npmjs.com/package/@0xdoublesharp/lru-cache-clustered"><img src="https://img.shields.io/npm/dt/%400xdoublesharp%2Flru-cache-clustered.svg" alt="Downloads"></a>
</p>

---

Node's `cluster` module gives every worker its own heap, so an in-process cache duplicates across workers and every worker cold-starts alone. An 8-worker service with a 200 MB cache pays **1.6 GB to hold the same data eight times**.

This package keeps a single `lru-cache` in the primary and lets every worker read and write it over `cluster` IPC. One copy of the data, shared warmth across workers, and atomic counters and single-flight fetches that stay correct cluster-wide. No Redis tier, no sidecar.

<p align="center">
  <img src="https://raw.githubusercontent.com/doublesharp/lru-cache-clustered/main/assets/topology.svg" alt="One LRU cache shared across cluster workers via IPC. The primary process holds a Map of namespaced LRUCache instances; each worker sends typed IPC requests to the primary for every cache operation." width="100%">
</p>

## Highlights

| Capability                     | What it gives you                                                                                          |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------- |
| **One cache, N workers**       | The primary owns the data. Memory cost stays flat as you scale workers, instead of multiplying.            |
| **No per-worker cold start**   | The first worker to load a value warms it for every other worker.                                          |
| **Atomic counters**            | `incr` / `decr` execute on the primary, so they stay race-safe under any worker count.                     |
| **Cluster-wide single-flight** | Concurrent misses for the same key collapse to one fetch via `fetch()` / `memoize()`.                      |
| **Optional local L1**          | Per-worker hot-read cache skips IPC while the primary remains authoritative.                               |
| **Atomic claims**              | `setIfAbsent()` lets exactly one worker win a key &mdash; perfect for idempotent intake or once-only init. |
| **Pluggable codecs**           | `wrap()` layers gzip, MessagePack, or any symmetric encoder over a cache without changing call sites.      |
| **Per-namespace stats**        | Hits, misses, sets, deletes, evictions, size &mdash; ready to scrape, no extra wiring.                     |
| **Rate-limiter-friendly TTLs** | `incr` keeps the original window ticking instead of resetting it on every bump.                            |
| **Structured IPC errors**      | Worker-side rejections preserve `name`, `code`, `cause`, and `stack` from the primary.                     |

## Install

`lru-cache` is a peer dependency &mdash; install it alongside this package so you control the version.

```sh
npm install @0xdoublesharp/lru-cache-clustered lru-cache
pnpm add @0xdoublesharp/lru-cache-clustered lru-cache
yarn add @0xdoublesharp/lru-cache-clustered lru-cache
```

TypeScript first. Dual ESM + CJS. Requires Node &ge; 22.

> The legacy package name `lru-cache-for-clusters-as-promised` is published from the same build at the same version, so existing imports keep working during a phased migration.

## Quick start

```ts
import cluster from 'node:cluster';
import { availableParallelism } from 'node:os';
import { LRUCacheClustered } from '@0xdoublesharp/lru-cache-clustered';

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
  // {"name":"ada"} - every worker sees the same value
}
```

A few things worth knowing up front:

- **`LRUCacheClustered` is the canonical class.** `LRUCacheForClustersAsPromised` is still exported as a backward-compatible alias.
- **Import in the primary before `cluster.fork()`.** The primary-side IPC listener is installed at module import. Call `LRUCacheClustered.bootstrap()` if you want that setup to be explicit.
- **This is a coordination layer, not a security boundary.** Any code in any worker can use any namespace it knows; do not expose namespaces to untrusted callers.

## When to use it

Reach for this package when you have a multi-worker Node service and want shared in-process caching without standing up a separate caching tier:

- Session and profile caches
- Rate limiters and quota counters
- Feature flag snapshots
- Deduplicating expensive API or database calls
- Any cache-aside pattern across workers

It is also a strong fit as the **L1 in a multi-layer cache** in front of Redis or Memcached. Hot keys are served in-process, the long tail falls through to the shared remote cache, and the origin only sees true cold misses.

Reach for something else when you need sharing across multiple machines (use Redis or Memcached, or layer this in front of one), or when your hottest path cannot tolerate an IPC hop on a miss. See [Performance profile](#performance-profile).

## Examples

Runnable clustered server examples &mdash; see [`examples/README.md`](./examples/README.md) for run instructions and curl recipes.

- [`clustered-users-server.ts`](./examples/clustered-users-server.ts) &mdash; shared read-through user cache via `memoize()` / `fetch()`
- [`clustered-rate-limit-server.ts`](./examples/clustered-rate-limit-server.ts) &mdash; fixed-window rate limiting via atomic `incr()`
- [`clustered-session-server.ts`](./examples/clustered-session-server.ts) &mdash; shared session storage via `set()` / `get()` / `delete()`
- [`clustered-idempotency-server.ts`](./examples/clustered-idempotency-server.ts) &mdash; idempotent job intake via `setIfAbsent()`
- [`clustered-compressed-documents-server.ts`](./examples/clustered-compressed-documents-server.ts) &mdash; compressed document caching via `wrap()`
- [`clustered-l1-server.ts`](./examples/clustered-l1-server.ts) &mdash; local L1 mode with per-worker stats, bypass reads, and invalidation
- [`clustered-multilayer-redis-server.ts`](./examples/clustered-multilayer-redis-server.ts) &mdash; clustered LRU as L1 in front of Redis as L2, with cluster-wide single-flight on cold keys

## Local L1 mode

Add a per-worker LRU cache in front of the primary-owned shared cache to skip IPC for hot reads. The primary cache remains the source of truth and still owns every write.

```ts
const products = new LRUCacheClustered<string, Product>({
  namespace: 'products',
  max: 25_000,
  ttl: 60_000,
  localL1: { enabled: true, experimental: true, ttl: 2_000 },
});
```

> L1 improves repeated read latency by avoiding IPC, but it can briefly serve stale data. Keep L1 TTL short and bypass L1 for correctness-sensitive reads.

In v2.1, set `experimental: true` to opt in. The L1 TTL is capped at the primary TTL; if omitted, it defaults to `min(primaryTtl * 0.1, 5000)` with a 100 ms floor.

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

The local surface also includes:

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

`new LRUCacheClustered(...)` branches at construction:

- **In the primary** (`cluster.isPrimary === true`), the instance owns and operates on the in-process `LRUCache` for its namespace directly &mdash; no IPC, no allocation per call.
- **In a worker**, every operation becomes a typed IPC request to the primary; the returned Promise resolves with the response.

Instances in different workers that share a `namespace` operate on the same primary-side cache. Those instances should agree on cache options (`max`, `ttl`, `allowStale`, ...): reusing a namespace with conflicting options throws rather than silently keeping whichever process initialized it first.

> **Initialization semantics.** In a worker, `new LRUCacheClustered(...)` eagerly sends the `init` message, but `cache.ready` is ordering-only and intentionally swallows init failure. Use `await cache.healthCheck()` or `await LRUCacheClustered.getInstance(...)` when startup should fail fast if the primary cannot register the namespace.

## Performance profile

- **Primary mode** &mdash; operations dispatch directly to the local `lru-cache` instance, bypassing the IPC machinery entirely (no message build, no request-ID allocation, no pending-response bookkeeping).
- **Worker mode** &mdash; every cache operation is an IPC round trip through the primary.
- **Worker mode with local L1** &mdash; hot `get`, `has`, `peek`, `mGet`, and `fetch` reads can be served from process-local memory with no IPC; misses still go to the primary.
- **Hot misses** &mdash; `fetch()` and `memoize()` collapse concurrent misses for the same key across workers, so origin work scales with unique keys, not concurrent callers.
- **Design tradeoff** &mdash; pick this package when cross-worker sharing and single-copy memory matter more than per-call latency; pick plain per-process `lru-cache` when your hottest path cannot afford the IPC hop.

## Options

The serializable subset of [`lru-cache`](https://github.com/isaacs/node-lru-cache) constructor options passes through (`max`, `maxSize`, `maxEntrySize`, `ttl`, `allowStale`, `updateAgeOnGet`, `updateAgeOnHas`, `noDeleteOnStaleGet`, `ttlAutopurge`). Plus:

| Option      | Type                      | Default     | Description                                                                                                   |
| ----------- | ------------------------- | ----------- | ------------------------------------------------------------------------------------------------------------- |
| `namespace` | `string`                  | `'default'` | Logical name. Instances sharing a namespace share state on the primary.                                       |
| `timeout`   | `number`                  | `100`       | Worker IPC timeout in ms.                                                                                     |
| `failsafe`  | `'resolve' \| 'reject'`   | `'resolve'` | On worker IPC timeout: `'resolve'` resolves with `undefined`; `'reject'` rejects with `Error('IPC timeout')`. |
| `localL1`   | `false \| LocalL1Options` | `undefined` | Optional local hot-read cache. Pass `{ enabled: true, experimental: true }` to opt in.                        |

`LocalL1Options`:

| Option           | Type                        | Default       | Description                                                                                           |
| ---------------- | --------------------------- | ------------- | ----------------------------------------------------------------------------------------------------- |
| `enabled`        | `boolean`                   | `true`        | Set `false` to disable when an options object is reused.                                              |
| `experimental`   | `boolean`                   | required      | Must be `true` in v2.1 to acknowledge eventual consistency.                                           |
| `max`            | `number`                    | `1000`        | Maximum local entries per instance.                                                                   |
| `maxSize`        | `number`                    | `undefined`   | Optional local size bound. Uses one size unit per entry.                                              |
| `ttl`            | `number`                    | derived       | Local TTL in ms, capped by primary TTL and per-entry remaining TTL.                                   |
| `updateAgeOnGet` | `boolean`                   | `true`        | Passed to the local `lru-cache`.                                                                      |
| `allowStale`     | `boolean`                   | `false`       | Passed to the local `lru-cache`; stale reads increment `localStats().staleHits`.                      |
| `invalidation`   | `'broadcast' \| 'ttl-only'` | `'broadcast'` | Whether this instance subscribes to local/IPC invalidation pushes or relies only on local TTL expiry. |
| `methods`        | `{ get?, has?, fetch? }`    | all enabled   | Restrict which read families use L1. If present, omitted keys are disabled.                           |
| `cacheUndefined` | `boolean`                   | unsupported   | Reserved for future negative-result caching; currently forced off.                                    |

Function-valued `lru-cache` options such as `dispose`, `disposeAfter`, `sizeCalculation`, or `fetchMethod` do not cross IPC and are not supported by this wrapper.

> **`failsafe: 'resolve'` caveat.** On timeout, `'resolve'` returns `undefined` for _every_ op, regardless of declared return type. For `get` / `peek` that is natural; for `has` / `set` / `delete` / `incr` / `decr` / `size` it can surprise callers (`undefined + 1 === NaN`). Use `'reject'` if typed-shape correctness on timeout matters.

> **Size-bounded caches.** When you use `maxSize` or `maxEntrySize`, provide `size` on every write path (`set`, `setIfAbsent`, `mSet`, `fetch`, `memoize`, and the first `incr` / `decr` for a counter key). `sizeCalculation` does not cross IPC, so the primary cannot infer it for you.

> **Fail-fast startup.** `LRUCacheClustered.getInstance()` and `cache.healthCheck()` always reject if the primary cannot answer, regardless of `failsafe`, so you can use them as hard startup checks.

> **Key/value contract.** Like `lru-cache`, keys and values must be non-nullish. Passing `null` or `undefined` rejects instead of relying on ambiguous cache semantics.

## API

### Static

| Method                                   | Description                                                                                                                                                                      |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `LRUCacheClustered.bootstrap()`          | Installs the primary-side cluster listener immediately. Useful when you want an explicit bootstrap call instead of relying on module import side effects.                        |
| `LRUCacheClustered.getInstance(options)` | Async factory. In a worker, awaits the init message so the primary has registered the namespace before returning. Preferred when worker startup should fail fast on init errors. |
| `LRUCacheClustered.getAllCaches()`       | Returns the `Map<namespace, LRUCache>` registry. **Primary only** &mdash; throws in workers.                                                                                     |

### Core

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

| Method                           | Returns                           | Notes                                                                                                            |
| -------------------------------- | --------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `mGet(keys, { bypassL1? })`      | `Promise<Map<K, V \| undefined>>` | Preserves input key order even when L1 partially hits.                                                           |
| `mSet(entries, { ttl?, size? })` | `Promise<void>`                   | `entries: Iterable<[K, V] \| [K, V, { ttl?, size? }]>`; outer opts apply as defaults. Clears this instance's L1. |
| `mDelete(keys)`                  | `Promise<void>`                   |                                                                                                                  |

### Enumeration

| Method                     | Returns                         | Notes                                                           |
| -------------------------- | ------------------------------- | --------------------------------------------------------------- |
| `keys()`                   | `Promise<K[]>`                  | MRU first.                                                      |
| `values()`                 | `Promise<V[]>`                  | MRU first.                                                      |
| `entries()`                | `Promise<[K, V][]>`             | MRU first.                                                      |
| `[Symbol.asyncIterator]()` | `AsyncIterableIterator<[K, V]>` | `for await (const [k, v] of cache)`. Materializes the full set. |
| `dump()`                   | `Promise<[K, Entry][]>`         | Serializable snapshot.                                          |
| `load(entries)`            | `Promise<void>`                 | Restores from a `dump()`, preserving per-entry TTL metadata.    |
| `size()`                   | `Promise<number>`               |                                                                 |

### Counters and cache-aside

| Method                                                           | Returns                | Notes                                                                                                              |
| ---------------------------------------------------------------- | ---------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `incr(key, amount?, { ttl?, size? })`                            | `Promise<number>`      | Atomic on the primary. `ttl` is set on the **first** write only; later increments do not reset it (rate limiters). |
| `decr(key, amount?, { ttl?, size? })`                            | `Promise<number>`      | Same.                                                                                                              |
| `fetch(key, fetcher, { ttl?, size?, forceRefresh?, bypassL1? })` | `Promise<V>`           | Cache-aside with cluster-wide single-flight semantics. See [Single-flight semantics](#single-flight-semantics).    |
| `memoize(cache, fn, keyFn, opts?)`                               | `(args) => Promise<V>` | Top-level helper. Single-flight via `cache.fetch()`. See [`memoize` helper](#memoize-helper).                      |

### Local L1

| Method / event                                    | Returns / payload         | Notes                                                                                    |
| ------------------------------------------------- | ------------------------- | ---------------------------------------------------------------------------------------- |
| `localStats()`                                    | `L1Stats \| undefined`    | `undefined` when local L1 is disabled.                                                   |
| `clearLocal()`                                    | `void`                    | Local-only flush.                                                                        |
| `invalidateLocal(key)`                            | `void`                    | Local-only single-key invalidation.                                                      |
| `withoutLocal()`                                  | `LRUCacheClustered<K, V>` | Bypass view for `get`, `has`, `peek`, `mGet`, and `fetch`; writes pass through normally. |
| `on('l1:hit' \| 'l1:miss' \| 'l1:set', listener)` | `{ namespace, key }`      | Key is the original cache key, not an internal encoded key.                              |
| `on('l1:invalidate', listener)`                   | `{ namespace, key }`      | `key` may be `'*'` for namespace-wide invalidation.                                      |
| `on('l1:evict' \| 'l1:stale-hit', listener)`      | `{ namespace, key }`      | `stale-hit` fires when a TTL-stale local value is returned under `allowStale`.           |
| `off(event, listener)` / `once(event, listener)`  | `this`                    | Standard event helpers.                                                                  |

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
| `max(value?)`          | `Promise<number>`       | Getter and setter. Setter preserves primary entries and remaining TTL metadata, then clears this instance's L1.                                 |
| `ttl(value?)`          | `Promise<number>`       | Getter and setter. Setter clears this instance's L1.                                                                                            |
| `allowStale(value?)`   | `Promise<boolean>`      | Getter and setter.                                                                                                                              |

## `wrap` &mdash; codec / compression

`wrap(cache, codec)` returns a typed view where values pass through an `encode` / `decode` pair on the way in and out. Use it for compression (gzip, brotli), serialization (MessagePack), or any custom symmetric transform. The library stays codec-agnostic &mdash; bring your own.

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

`encode` and `decode` may be sync or async. The wrapped surface covers value-touching ops (`get`, `set`, `setIfAbsent`, `peek`, `mGet`, `mSet`, `values`, `entries`, async iteration, `fetch`) plus the lifecycle and metric pass-throughs (`has`, `delete`, `keys`, `size`, `clear`, `destroy`, `healthCheck`, `purgeStale`, `getRemainingTTL`, `stats`). Wrapped `get`, `has`, `peek`, `mGet`, and `fetch` forward read options such as `{ bypassL1: true }` to the underlying cache.

`incr` / `decr` and `dump` / `load` are not wrapped &mdash; they speak in numbers or the raw stored form. Reach them via `wrapped.cache` if you need them.

> **Buffer-typed values.** Cluster IPC serializes through JSON, which does not preserve `Buffer`. If a codec stores `Buffer` directly, in worker mode the decoded side will receive `{ type: 'Buffer', data: number[] }` and most binary APIs will reject it. Encode to a string (base64, hex) &mdash; or rehydrate inside `decode` &mdash; when the wrapped cache is read from workers. Primary-only use is unaffected.

## `memoize` helper

Cache-aside in one line. Concurrent calls for the same key coordinate through `cache.fetch()` so only one caller does the underlying work at a time.

```ts
import { LRUCacheClustered, memoize } from '@0xdoublesharp/lru-cache-clustered';

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

### Single-flight semantics

Both `memoize()` and `cache.fetch()` coordinate through the primary so concurrent misses for the same key collapse to one in-flight fetch across instances and workers.

Passing `forceRefresh: true` skips both the cache lookup and any in-flight claim and starts a fresh leader fetch. Concurrent callers without `forceRefresh` still wait on whichever fetch is in flight and reuse its result. Passing `bypassL1: true` skips local L1 reads and population for that call while preserving the primary-side single-flight behavior.

The cache `timeout` option only bounds each worker IPC request. It does not cancel user fetcher work after a worker owns the primary-side single-flight lock, so production fetchers should enforce their own upstream timeout or abort policy.

## Errors

**Worker mode.** When a primary-side handler throws, the worker's promise rejects with a reconstructed `Error` carrying the original `name`, `message`, `code`, `stack`, and `cause` chain. The rejected value is always a plain `Error` (subclass identity is not crossed over IPC), but `.name`, `.code`, and `.cause` are intact, so logging and cause-chain walking work. Errors travel as `{ name, message, code?, stack?, cause? }` on the wire.

**Primary mode.** No IPC: a thrown `Error` rejects as-is (subclass identity preserved); a thrown non-`Error` value is wrapped in `new Error(String(value))`. For `Error` throws the two modes are observably equivalent.

## Debugging

```sh
DEBUG=lru-cache-clustered-* node app.js
```

Available namespaces:

- `lru-cache-clustered-primary` &mdash; cache creation, registry events
- `lru-cache-clustered-messages` &mdash; every request/response over IPC

## Upgrading from 1.x

The 2.x line is a TypeScript rewrite on top of `lru-cache@11` with renamed methods and options. See [`docs/migration.md`](./docs/migration.md) for the full method, option, and package mapping, and [`CHANGELOG.md`](./CHANGELOG.md) for the complete 2.0 release notes.

## License

MIT &mdash; see [LICENSE](./LICENSE).
