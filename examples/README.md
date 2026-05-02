# Example servers

These examples are meant to be run from this repository:

```sh
pnpm example:users
pnpm example:rate-limit
pnpm example:sessions
pnpm example:idempotency
pnpm example:documents
pnpm example:multilayer
```

They import `../src/index.ts` so you can exercise the current workspace without building first. If you copy an example into another app, switch that import to `@0xdoublesharp/lru-cache-clustered`.

## `clustered-users-server.ts`

Small read-heavy API that demonstrates cluster-wide `memoize()` and `fetch()`.

```sh
pnpm example:users
curl http://127.0.0.1:3000/users/42
curl http://127.0.0.1:3000/users/42
curl 'http://127.0.0.1:3000/users/42?refresh=1'
curl http://127.0.0.1:3000/stats
```

What to look for:

- `servedBy.pid` is the worker that answered the HTTP request.
- `user.fetchedByPid` is the worker that actually loaded the record on a cache miss.
- If those differ, one worker served a value loaded by another worker through the shared cache.

## `clustered-rate-limit-server.ts`

Small write-heavy API that demonstrates atomic `incr()` with TTL.

```sh
pnpm example:rate-limit
curl 'http://127.0.0.1:3001/check?client=demo'
curl 'http://127.0.0.1:3001/check?client=demo'
curl 'http://127.0.0.1:3001/check?client=demo'
curl 'http://127.0.0.1:3001/reset?client=demo'
curl http://127.0.0.1:3001/stats
```

What to look for:

- The request counter keeps increasing even when different workers serve the requests.
- Once a client key is created, later `incr()` calls do not extend the original TTL window.

## `clustered-session-server.ts`

Small shared session store that demonstrates `set()`, `get()`, `delete()`, and TTL inspection.

```sh
pnpm example:sessions
curl 'http://127.0.0.1:3002/login?sid=s1&user=ada'
curl 'http://127.0.0.1:3002/session?sid=s1'
curl 'http://127.0.0.1:3002/touch?sid=s1&cart=3'
curl 'http://127.0.0.1:3002/ttl?sid=s1'
curl 'http://127.0.0.1:3002/logout?sid=s1'
```

What to look for:

- `session.updatedByPid` shows which worker last wrote the session.
- `servedBy.pid` can differ from that writer, showing a different worker read the same session state.

## `clustered-idempotency-server.ts`

Small webhook or job-intake example that demonstrates `setIfAbsent()` for cluster-wide duplicate suppression.

```sh
pnpm example:idempotency
curl 'http://127.0.0.1:3003/submit?key=checkout-123'
curl 'http://127.0.0.1:3003/status?key=checkout-123'
curl 'http://127.0.0.1:3003/reset?key=checkout-123'
```

What to look for:

- Only the first request for a key wins the claim.
- Concurrent duplicates return the existing in-flight or completed record instead of reprocessing.

## `clustered-compressed-documents-server.ts`

Small document cache that demonstrates `wrap()` with gzip compression for larger JSON payloads.

```sh
pnpm example:documents
curl 'http://127.0.0.1:3004/store?id=doc-1&kb=32'
curl 'http://127.0.0.1:3004/document?id=doc-1'
curl 'http://127.0.0.1:3004/delete?id=doc-1'
```

What to look for:

- Responses include both `jsonBytes` and `storedBytes`.
- The compressed size stays in the primary while callers read and write decoded JSON values.

## `clustered-multilayer-redis-server.ts`

Two-layer cache demonstrating clustered LRU as L1 in front of Redis as L2, with a simulated origin behind both. Uses `cache.fetch()` so concurrent L1 misses for the same key collapse to a single Redis read across the whole cluster.

Requires a running Redis (defaults to `redis://127.0.0.1:6379`) and the `redis` client package:

```sh
pnpm add -D redis
pnpm example:multilayer
curl http://127.0.0.1:3005/products/42
curl http://127.0.0.1:3005/products/42
curl 'http://127.0.0.1:3005/products/42/invalidate'
curl http://127.0.0.1:3005/stats
```

What to look for:

- First request returns `source: "origin"`. Repeats within `L1_TTL_MS` return `source: "l1"`.
- After L1 expires but before L2 expires (`L2_TTL_S`), the next request returns `source: "l2"` and re-warms L1.
- Invalidate the key, then call again: `source: "origin"`.
- Fire many concurrent requests for a cold key — only one worker reaches origin; the rest reuse the leader's value.

## Environment variables

All examples accept:

- `PORT`
- `WORKERS`

The users example also accepts:

- `CACHE_TTL_MS`

The rate-limit example also accepts:

- `LIMIT`
- `WINDOW_MS`

The multilayer example also accepts:

- `REDIS_URL` (default `redis://127.0.0.1:6379`)
- `L1_TTL_MS` (default `5000`)
- `L2_TTL_S` (default `60`)
- `ORIGIN_LATENCY_MS` (default `250`)
