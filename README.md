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

| Method                      | Returns                           | Notes                                                        |
| --------------------------- | --------------------------------- | ------------------------------------------------------------ |
| `getCache()`                | `LRUCache \| undefined`           | Underlying `lru-cache` for this namespace. **Primary only**. |
| `get(key)`                  | `Promise<V \| undefined>`         |                                                              |
| `set(key, value, { ttl? })` | `Promise<boolean>`                |                                                              |
| `delete(key)`               | `Promise<boolean>`                |                                                              |
| `has(key)`                  | `Promise<boolean>`                |                                                              |
| `peek(key)`                 | `Promise<V \| undefined>`         | Doesn't update LRU position.                                 |
| `clear()`                   | `Promise<void>`                   |                                                              |
| `purgeStale()`              | `Promise<boolean>`                | Removes expired entries.                                     |
| `mGet(keys)`                | `Promise<Map<K, V \| undefined>>` |                                                              |
| `mSet(entries, { ttl? })`   | `Promise<void>`                   | `entries: Iterable<[K, V]>`                                  |
| `mDelete(keys)`             | `Promise<void>`                   |                                                              |
| `keys()`                    | `Promise<K[]>`                    | MRU first.                                                   |
| `values()`                  | `Promise<V[]>`                    | MRU first.                                                   |
| `entries()`                 | `Promise<[K,V][]>`                | MRU first.                                                   |
| `dump()`                    | `Promise<[K, Entry][]>`           | Serializable form.                                           |
| `size()`                    | `Promise<number>`                 |                                                              |
| `incr(key, amount?)`        | `Promise<number>`                 | Atomic on the primary; race-safe across workers.             |
| `decr(key, amount?)`        | `Promise<number>`                 | Same.                                                        |
| `max(value?)`               | `Promise<number>`                 | Getter and setter.                                           |
| `ttl(value?)`               | `Promise<number>`                 | Getter and setter.                                           |
| `allowStale(value?)`        | `Promise<boolean>`                | Getter and setter.                                           |

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
