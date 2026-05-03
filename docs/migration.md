# Migrating from older releases

The 2.x line is a TypeScript rewrite on top of `lru-cache@11`. The old method and option names from the `lru-cache@6` era have been retired in favor of the modern `lru-cache` surface, so most of the migration is a search-and-replace.

## Method and option mapping

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

## Package name

The current package is `@0xdoublesharp/lru-cache-clustered`. The legacy unscoped package `lru-cache-for-clusters-as-promised` is published from the same build at the same version, so you can keep the old import path during a phased migration.

## Debug namespace

Earlier releases used `lru-cache-for-clusters-as-promised-*`. The current namespaces are `lru-cache-clustered-primary` and `lru-cache-clustered-messages`.

## Cluster terminology

Internal references to `master` were renamed to `primary` to match Node's `cluster.isPrimary`. If you were calling the internal `sendToMaster` helper, it is now `sendToPrimary`.

For the full set of 2.0 changes, see the [CHANGELOG](../CHANGELOG.md).
