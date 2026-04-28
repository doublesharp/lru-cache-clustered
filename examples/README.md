# Example servers

These examples are meant to be run from this repository:

```sh
pnpm example:users
pnpm example:rate-limit
```

They import `../src/index.ts` so you can exercise the current workspace without building first. If you copy either example into another app, switch that import to `lru-cache-for-clusters-as-promised`.

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

## Environment variables

Both examples accept:

- `PORT`
- `WORKERS`

The users example also accepts:

- `CACHE_TTL_MS`

The rate-limit example also accepts:

- `LIMIT`
- `WINDOW_MS`
