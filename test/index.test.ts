import test from 'node:test';
import assert from 'node:assert/strict';
import { LRUCacheClustered } from '../src/index.ts';
import { caches } from '../src/primary.ts';

void test('primary-mode set/get/delete round-trip', async () => {
  caches.clear();
  const cache = new LRUCacheClustered<string, string>({ namespace: 'idx-1', max: 10 });
  await cache.set('k', 'v');
  assert.equal(await cache.get('k'), 'v');
  assert.equal(await cache.has('k'), true);
  assert.equal(await cache.delete('k'), true);
  assert.equal(await cache.get('k'), undefined);
});

void test('primary-mode mGet/mSet/mDelete', async () => {
  caches.clear();
  const cache = new LRUCacheClustered<string, number>({ namespace: 'idx-2', max: 10 });
  await cache.mSet([
    ['a', 1],
    ['b', 2],
  ]);
  const got = await cache.mGet(['a', 'b', 'c']);
  assert.deepEqual(
    [...got.entries()],
    [
      ['a', 1],
      ['b', 2],
      ['c', undefined],
    ],
  );
  await cache.mDelete(['a']);
  assert.equal(await cache.get('a'), undefined);
});

void test('primary-mode incr/decr', async () => {
  caches.clear();
  const cache = new LRUCacheClustered<string, number>({ namespace: 'idx-3' });
  assert.equal(await cache.incr('hits'), 1);
  assert.equal(await cache.incr('hits', 4), 5);
  assert.equal(await cache.decr('hits'), 4);
});

void test('primary-mode size, keys, values, entries, clear', async () => {
  caches.clear();
  const cache = new LRUCacheClustered<string, number>({ namespace: 'idx-4', max: 10 });
  await cache.set('a', 1);
  await cache.set('b', 2);
  assert.equal(await cache.size(), 2);
  assert.deepEqual(await cache.keys(), ['b', 'a']);
  assert.deepEqual(await cache.values(), [2, 1]);
  assert.deepEqual(await cache.entries(), [
    ['b', 2],
    ['a', 1],
  ]);
  await cache.clear();
  assert.equal(await cache.size(), 0);
});

void test('primary-mode non-L1 mutation helpers run without local invalidation state', async () => {
  caches.clear();
  const cache = new LRUCacheClustered<string, number>({ namespace: 'idx-no-l1-mutators', max: 10, ttl: 10 });
  await cache.set('a', 1);
  await cache.set('b', 2);
  await cache.mDelete(['b']);
  assert.equal(await cache.get('b'), undefined);
  assert.equal(await cache.decr('a'), 0);

  const dump = await cache.dump();
  await cache.clear();
  await cache.load(dump);
  assert.equal(await cache.get('a'), 0);

  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(await cache.purgeStale(), true);
});

void test('primary-mode config getters/setters', async () => {
  caches.clear();
  const cache = new LRUCacheClustered<string, number>({ namespace: 'idx-5', max: 10, ttl: 1000 });
  assert.equal(await cache.max(), 10);
  assert.equal(await cache.max(50), 50);
  assert.equal(await cache.ttl(), 1000);
  assert.equal(await cache.ttl(2000), 2000);
  assert.equal(await cache.allowStale(), false);
  assert.equal(await cache.allowStale(true), true);
});

void test('primary-mode max setter preserves per-entry TTL metadata', async () => {
  caches.clear();
  const cache = new LRUCacheClustered<string, string>({ namespace: 'idx-5-ttl', max: 10 });
  await cache.set('k', 'v', { ttl: 50 });
  await new Promise((r) => setTimeout(r, 20));
  const before = await cache.getRemainingTTL('k');

  await cache.max(50);
  const after = await cache.getRemainingTTL('k');

  assert.ok(before > 0);
  assert.ok(after > 0, `expected positive ttl after rebuild, got ${after}`);
  assert.ok(after <= before, `expected ttl to keep ticking down (${after} <= ${before})`);
});

void test('namespace isolation between instances', async () => {
  caches.clear();
  const a = new LRUCacheClustered({ namespace: 'iso-a' });
  const b = new LRUCacheClustered({ namespace: 'iso-b' });
  await a.set('k', 'A');
  await b.set('k', 'B');
  assert.equal(await a.get('k'), 'A');
  assert.equal(await b.get('k'), 'B');
});

void test('getInstance resolves to a usable cache', async () => {
  caches.clear();
  const cache = await LRUCacheClustered.getInstance<string, string>({ namespace: 'gi', max: 5 });
  await cache.set('x', 'y');
  assert.equal(await cache.get('x'), 'y');
});

void test('getAllCaches returns the registry on primary', async () => {
  caches.clear();
  new LRUCacheClustered({ namespace: 'gac', max: 5 });
  const all = LRUCacheClustered.getAllCaches();
  assert.ok(all instanceof Map);
  assert.ok(all.has('gac'));
});

void test('getCache returns the underlying lru-cache instance on primary', async () => {
  caches.clear();
  const cache = new LRUCacheClustered<string, string>({ namespace: 'gc', max: 5 });
  await cache.set('a', 'b');
  const inner = cache.getCache();
  assert.ok(inner);
  assert.equal((inner as { get: (k: string) => unknown }).get('a'), 'b');
});

void test('bootstrap is idempotent on primary', () => {
  assert.doesNotThrow(() => LRUCacheClustered.bootstrap());
  assert.doesNotThrow(() => LRUCacheClustered.bootstrap());
});

void test('healthCheck resolves on primary', async () => {
  caches.clear();
  const cache = new LRUCacheClustered<string, string>({ namespace: 'health-1', max: 5 });
  await assert.doesNotReject(cache.healthCheck());
});

void test('peek does not promote, dump and purgeStale work', async () => {
  caches.clear();
  const cache = new LRUCacheClustered<string, string>({ namespace: 'pdp', max: 3 });
  await cache.set('a', 'A');
  await cache.set('b', 'B');
  await cache.set('c', 'C');
  // peek does not promote 'a' to most-recently-used
  assert.equal(await cache.peek('a'), 'A');
  // adding 'd' should evict 'a' (still LRU because peek didn't promote)
  await cache.set('d', 'D');
  assert.equal(await cache.get('a'), undefined);

  const dump = await cache.dump();
  assert.ok(Array.isArray(dump));
  assert.equal(dump.length, 3);

  const purged = await cache.purgeStale();
  assert.equal(typeof purged, 'boolean');
});

void test('set with ttl and mSet with ttl', async () => {
  caches.clear();
  const cache = new LRUCacheClustered<string, string>({ namespace: 'ttl-opt', max: 10 });
  await cache.set('a', 'A', { ttl: 50_000 });
  await cache.mSet(
    [
      ['b', 'B'],
      ['c', 'C'],
    ],
    { ttl: 50_000 },
  );
  assert.equal(await cache.get('a'), 'A');
  assert.equal(await cache.get('b'), 'B');
  assert.equal(await cache.get('c'), 'C');
});

void test('size-bounded caches accept size on set/setIfAbsent/mSet', async () => {
  caches.clear();
  const cache = new LRUCacheClustered<string, string>({
    namespace: 'size-opt',
    maxSize: 10,
    maxEntrySize: 10,
  });
  await cache.set('a', 'AA', { size: 2 });
  assert.equal(await cache.setIfAbsent('b', 'BBB', { size: 3 }), true);
  await cache.mSet([
    ['c', 'C', { size: 1 }],
    ['d', 'DD', { size: 2 }],
  ]);
  assert.equal(await cache.get('a'), 'AA');
  assert.equal(await cache.get('b'), 'BBB');
  assert.equal(await cache.get('c'), 'C');
  assert.equal(await cache.get('d'), 'DD');
});

void test('destroy removes a namespace and later reuse recreates it with original options', async () => {
  caches.clear();
  const cache = new LRUCacheClustered<string, string>({
    namespace: 'destroy-1',
    max: 10,
    ttl: 1_000,
  });
  await cache.set('before', 'A');
  assert.equal(LRUCacheClustered.getAllCaches().has('destroy-1'), true);
  assert.equal(await cache.destroy(), true);
  assert.equal(LRUCacheClustered.getAllCaches().has('destroy-1'), false);

  await cache.set('after', 'B');
  const ttl = await cache.getRemainingTTL('after');
  assert.ok(ttl > 0 && ttl <= 1_000);
});

void test('primary-mode rejects nullish keys and values', async () => {
  caches.clear();
  const cache = new LRUCacheClustered<string, string>({ namespace: 'nullish', max: 10 });
  await assert.rejects(cache.set(undefined as never, 'v'), /cache key must not be null or undefined/);
  await assert.rejects(cache.set('k', undefined as never), /cache value must not be null or undefined/);
  await assert.rejects(cache.get(null as never), /cache key must not be null or undefined/);
});

void test('options defaults and explicit failsafe=reject', () => {
  caches.clear();
  const cdef = new LRUCacheClustered();
  assert.equal(cdef.namespace, 'default');
  assert.equal(cdef.timeout, 100);
  assert.equal(cdef.failsafe, 'resolve');

  const ccustom = new LRUCacheClustered({
    namespace: 'cn',
    timeout: 250,
    failsafe: 'reject',
  });
  assert.equal(ccustom.namespace, 'cn');
  assert.equal(ccustom.timeout, 250);
  assert.equal(ccustom.failsafe, 'reject');
});

void test('namespace re-init rejects conflicting cache options', () => {
  caches.clear();
  new LRUCacheClustered({ namespace: 'conflict', max: 1, ttl: 111 });
  assert.throws(() => new LRUCacheClustered({ namespace: 'conflict', max: 2 }), /Conflicting options/);
});

void test('dispatch rejects when handler throws', async () => {
  caches.clear();
  const cache = new LRUCacheClustered<string, string>({
    namespace: 'errpath',
    max: 10,
  });
  // Force the underlying cache to throw on get — exercises the handler's
  // try/catch and #dispatch's reject branch.
  const inner = caches.get('errpath');
  assert.ok(inner);
  (inner as { get: (k: unknown) => unknown }).get = () => {
    throw new Error('synthetic failure');
  };
  await assert.rejects(cache.get('k'), /synthetic failure/);
});

void test('dispatch wraps non-Error rejections in Error', async () => {
  caches.clear();
  const cache = new LRUCacheClustered<string, string>({
    namespace: 'nonerr',
    max: 10,
  });
  const inner = caches.get('nonerr');
  assert.ok(inner);
  // Throw a string (not an Error) to hit the `new Error(String(e))` branch.
  (inner as { get: (k: unknown) => unknown }).get = () => {
    // eslint-disable-next-line @typescript-eslint/only-throw-error
    throw 'plain-string-throw';
  };
  await assert.rejects(cache.get('k'), (err: unknown) => {
    assert.ok(err instanceof Error);
    assert.match(err.message, /plain-string-throw/);
    return true;
  });
});

void test('decr accepts ttl option', async () => {
  caches.clear();
  const cache = new LRUCacheClustered<string, number>({ namespace: 'decr-ttl', max: 10 });
  const v = await cache.decr('counter', 2, { ttl: 60_000 });
  assert.equal(v, -2);
});

void test('counters reuse their existing size metadata in maxSize caches', async () => {
  caches.clear();
  const cache = new LRUCacheClustered<string, number>({
    namespace: 'counter-size',
    maxSize: 10,
  });
  assert.equal(await cache.incr('counter', 1, { size: 4 }), 1);
  assert.equal(await cache.incr('counter'), 2);
  assert.equal(await cache.decr('counter'), 1);
});

void test('ready resolves to undefined in primary mode', async () => {
  caches.clear();
  const cache = new LRUCacheClustered<string, string>({ namespace: 'ready-1' });
  assert.equal(await cache.ready, undefined);
});

void test('getRemainingTTL returns a number consistent with ttl presence', async () => {
  caches.clear();
  const cache = new LRUCacheClustered<string, string>({ namespace: 'rt-1', max: 10 });
  await cache.set('with-ttl', 'v', { ttl: 60_000 });
  await cache.set('no-ttl', 'v');
  const withTtl = await cache.getRemainingTTL('with-ttl');
  const noTtl = await cache.getRemainingTTL('no-ttl');
  assert.equal(typeof withTtl, 'number');
  assert.equal(typeof noTtl, 'number');
  assert.ok(withTtl > 0 && withTtl <= 60_000);
  // No-ttl entries report a sentinel that is not a positive finite ttl —
  // either Infinity or 0 depending on lru-cache version. We just assert it's
  // not in the (0, 60_000] window we used for the ttl'd entry.
  assert.ok(!(noTtl > 0 && noTtl <= 60_000));
});

void test('setIfAbsent returns true on first call, false on second', async () => {
  caches.clear();
  const cache = new LRUCacheClustered<string, string>({ namespace: 'sia-1', max: 10 });
  assert.equal(await cache.setIfAbsent('k', 'first'), true);
  assert.equal(await cache.setIfAbsent('k', 'second'), false);
  assert.equal(await cache.get('k'), 'first');
});

void test('setIfAbsent honors ttl on first set', async () => {
  caches.clear();
  const cache = new LRUCacheClustered<string, string>({ namespace: 'sia-2', max: 10 });
  assert.equal(await cache.setIfAbsent('k', 'v', { ttl: 50_000 }), true);
  const ttl = await cache.getRemainingTTL('k');
  assert.ok(ttl > 0 && ttl <= 50_000);
});

void test('load restores a previously dumped cache', async () => {
  caches.clear();
  const cache = new LRUCacheClustered<string, string>({ namespace: 'load-1', max: 10 });
  await cache.set('a', 'A');
  await cache.set('b', 'B');
  const dump = await cache.dump();
  await cache.clear();
  assert.equal(await cache.size(), 0);
  await cache.load(dump);
  assert.equal(await cache.get('a'), 'A');
  assert.equal(await cache.get('b'), 'B');
});

void test('stats() returns counters that update with cache activity', async () => {
  caches.clear();
  const cache = new LRUCacheClustered<string, string>({ namespace: 'stats-1', max: 10 });
  const s0 = await cache.stats();
  assert.equal(s0.namespace, 'stats-1');
  assert.equal(typeof s0.hits, 'number');
  assert.equal(typeof s0.misses, 'number');
  assert.equal(typeof s0.sets, 'number');
  assert.equal(typeof s0.deletes, 'number');

  await cache.set('a', 'A');
  await cache.get('a'); // hit
  await cache.get('missing'); // miss
  await cache.delete('a');

  const s1 = await cache.stats();
  assert.ok(s1.sets >= s0.sets + 1);
  assert.ok(s1.hits >= s0.hits + 1);
  assert.ok(s1.misses >= s0.misses + 1);
  assert.ok(s1.deletes >= s0.deletes + 1);
});

void test('incr with ttl preserves TTL across subsequent ttl-less incrs', async () => {
  caches.clear();
  const cache = new LRUCacheClustered<string, number>({ namespace: 'incr-ttl', max: 10 });
  await cache.incr('counter', 1, { ttl: 50_000 });
  const ttl1 = await cache.getRemainingTTL('counter');
  assert.ok(ttl1 > 0 && ttl1 <= 50_000);
  // small wait so we can detect a TTL reset
  await new Promise((r) => setTimeout(r, 10));
  await cache.incr('counter', 1);
  const ttl2 = await cache.getRemainingTTL('counter');
  // TTL should not have been reset to a brand new 50_000 window — it should
  // be <= ttl1 (give or take rounding).
  assert.ok(ttl2 <= ttl1);
  assert.ok(ttl2 > 0);
});

void test('[Symbol.asyncIterator] yields all entries', async () => {
  caches.clear();
  const cache = new LRUCacheClustered<string, number>({ namespace: 'aiter-1', max: 10 });
  await cache.set('a', 1);
  await cache.set('b', 2);
  await cache.set('c', 3);
  const collected: Array<[string, number]> = [];
  for await (const pair of cache) collected.push(pair);
  // Order matches entries(): MRU first
  assert.equal(collected.length, 3);
  const map = new Map(collected);
  assert.equal(map.get('a'), 1);
  assert.equal(map.get('b'), 2);
  assert.equal(map.get('c'), 3);
});

void test('fetch dedups concurrent calls and caches result', async () => {
  caches.clear();
  const cache = new LRUCacheClustered<string, string>({ namespace: 'fetch-1', max: 10 });
  let calls = 0;
  const fetcher = async (k: string) => {
    calls++;
    await new Promise((r) => setTimeout(r, 10));
    return `v-${k}`;
  };
  const [r1, r2, r3] = await Promise.all([
    cache.fetch('k', fetcher),
    cache.fetch('k', fetcher),
    cache.fetch('k', fetcher),
  ]);
  assert.equal(r1, 'v-k');
  assert.equal(r2, 'v-k');
  assert.equal(r3, 'v-k');
  assert.equal(calls, 1);

  // Subsequent call returns cached value without invoking fetcher again.
  const r4 = await cache.fetch('k', () => {
    throw new Error('should not be called');
  });
  assert.equal(r4, 'v-k');
  assert.equal(calls, 1);
});

void test('fetch shares a single miss-path get across concurrent callers', async () => {
  caches.clear();
  const cache = new LRUCacheClustered<string, number>({ namespace: 'fetch-get-dedup', max: 10 });
  let getCalls = 0;
  let fetchCalls = 0;

  (cache as { get: (key: string) => Promise<number | undefined> }).get = async () => {
    getCalls += 1;
    await new Promise((r) => setTimeout(r, 10));
    return undefined;
  };

  const fetcher = async () => {
    fetchCalls += 1;
    return 7;
  };

  const results = await Promise.all([cache.fetch('k', fetcher), cache.fetch('k', fetcher), cache.fetch('k', fetcher)]);
  assert.deepEqual(results, [7, 7, 7]);
  assert.equal(getCalls, 1);
  assert.equal(fetchCalls, 1);
});

void test('fetch followers in another instance reuse the leader result', async () => {
  caches.clear();
  const namespace = 'fetch-cross-instance-follower';
  const leaderCache = new LRUCacheClustered<string, string>({ namespace, max: 10 });
  const followerCache = new LRUCacheClustered<string, string>({ namespace, max: 10 });
  const originalPeek = followerCache.peek.bind(followerCache);
  let releaseLeader!: () => void;
  let leaderEntered!: () => void;
  let followerObservedMiss!: () => void;
  let leader!: Promise<string>;
  let followerPeekCalls = 0;
  const leaderGate = new Promise<void>((resolve) => {
    releaseLeader = resolve;
  });
  const leaderStarted = new Promise<void>((resolve) => {
    leaderEntered = resolve;
  });
  const followerMissed = new Promise<void>((resolve) => {
    followerObservedMiss = resolve;
  });
  (followerCache as { peek: (key: string) => Promise<string | undefined> }).peek = async (key) => {
    followerPeekCalls += 1;
    if (followerPeekCalls === 1) {
      followerObservedMiss();
      return undefined;
    }
    releaseLeader();
    await leader;
    return originalPeek(key);
  };

  leader = leaderCache.fetch('k', async () => {
    leaderEntered();
    await leaderGate;
    return 'shared';
  });
  await leaderStarted;

  const follower = followerCache.fetch('k', () => {
    throw new Error('follower should not run fetcher');
  });
  await followerMissed;

  assert.deepEqual(await Promise.all([leader, follower]), ['shared', 'shared']);
});

void test('fetch with forceRefresh re-invokes fetcher', async () => {
  caches.clear();
  const cache = new LRUCacheClustered<string, number>({ namespace: 'fetch-2', max: 10 });
  let calls = 0;
  const fetcher = async () => {
    calls++;
    return calls;
  };
  assert.equal(await cache.fetch('k', fetcher), 1);
  assert.equal(await cache.fetch('k', fetcher), 1); // cached
  assert.equal(await cache.fetch('k', fetcher, { forceRefresh: true }), 2);
  assert.equal(calls, 2);
});

void test('fetch accepts size-bounded writes', async () => {
  caches.clear();
  const cache = new LRUCacheClustered<string, string>({
    namespace: 'fetch-size',
    maxSize: 10,
  });
  let calls = 0;
  const fetcher = async () => {
    calls++;
    return 'OK';
  };
  assert.equal(await cache.fetch('k', fetcher, { size: 2 }), 'OK');
  assert.equal(await cache.fetch('k', fetcher, { size: 2 }), 'OK');
  assert.equal(calls, 1);
});

void test('fetch forceRefresh ignores stale in-flight result', async () => {
  caches.clear();
  const cache = new LRUCacheClustered<string, number>({ namespace: 'fetch-force', max: 10 });

  // First in-flight fetcher returns a stale value.
  const stale = async () => {
    await new Promise((r) => setTimeout(r, 20));
    return 1;
  };
  // Second fetcher returns the fresh value the forceRefresh caller wants.
  const fresh = async () => 2;

  const a = cache.fetch('k', stale); // non-force, in-flight, will return 1
  const b = cache.fetch('k', fresh, { forceRefresh: true });
  // The force caller must NOT piggyback on `stale`'s result; it must invoke
  // its own fetcher and resolve to 2.
  assert.equal(await b, 2);
  // The non-force caller is allowed to dedup onto whatever is in flight when
  // it resumes (could be the force caller's promise, since force overwrote
  // the in-flight slot). The contract we care about here is just that the
  // force caller saw fresh data.
  await a;
});

void test('fetch forceRefresh keeps the refreshed value cached when an older fetch finishes later', async () => {
  caches.clear();
  const cache = new LRUCacheClustered<string, number>({ namespace: 'fetch-force-final', max: 10 });

  const stale = async () => {
    await new Promise((r) => setTimeout(r, 20));
    return 1;
  };
  const fresh = async () => 2;

  const older = cache.fetch('k', stale);
  await Promise.resolve();

  assert.equal(await cache.fetch('k', fresh, { forceRefresh: true }), 2);
  await older;
  assert.equal(await cache.get('k'), 2);
});

void test('fetch does not populate L1 when fetchStore rejects an older token', async () => {
  caches.clear();
  const cache = new LRUCacheClustered<string, number>({
    namespace: 'fetch-l1-rejected-token',
    max: 10,
    localL1: { enabled: true, experimental: true, ttl: 1000 },
  });

  const stale = async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
    return 1;
  };
  const fresh = async () => 2;

  const older = cache.fetch('k', stale);
  await Promise.resolve();

  assert.equal(await cache.fetch('k', fresh, { forceRefresh: true }), 2);
  assert.equal(await older, 2);
  assert.equal(await cache.get('k'), 2);
});

void test('fetch propagates fetcher errors and clears in-flight slot', async () => {
  caches.clear();
  const cache = new LRUCacheClustered<string, string>({ namespace: 'fetch-3', max: 10 });
  let calls = 0;
  const failing = async () => {
    calls++;
    throw new Error('boom');
  };
  await assert.rejects(cache.fetch('k', failing), /boom/);
  // A subsequent fetch should re-invoke (not return a stale rejected promise).
  await assert.rejects(cache.fetch('k', failing), /boom/);
  assert.equal(calls, 2);

  // And once the fetcher succeeds, the value is cached.
  const ok = async () => 'recovered';
  assert.equal(await cache.fetch('k', ok), 'recovered');
  assert.equal(await cache.fetch('k', ok), 'recovered');
});

void test('fetch preserves fetcher errors when abort cleanup also fails', async () => {
  caches.clear();
  const cache = new LRUCacheClustered<string, string>({ namespace: 'fetch-cleanup-failure', max: 10 });
  const state = (globalThis as Record<PropertyKey, unknown>)[Symbol.for('lru-cache-clustered.primary')] as {
    fetchLocks: Map<unknown, unknown>;
  };
  const originalGet = state.fetchLocks.get.bind(state.fetchLocks);

  try {
    await assert.rejects(
      cache.fetch('k', () => {
        state.fetchLocks.get = () => {
          throw new Error('cleanup failed');
        };
        throw new Error('fetch failed');
      }),
      /fetch failed/,
    );
  } finally {
    state.fetchLocks.get = originalGet;
    state.fetchLocks.clear();
  }
});

// Default cluster IPC uses JSON serialization, which rewrites `undefined`
// inside arrays to `null`. The mGet wire format is Array<[K, V|undefined]>;
// without normalization a worker-mode caller would observe `Map<K, null>`
// for missing keys instead of the documented `Map<K, undefined>`. We
// exercise the normalization path by injecting `null` at the primary-side
// handler — equivalent to what the worker would receive over JSON IPC.
void test('mGet normalizes null pairs to undefined (JSON IPC compatibility)', async () => {
  caches.clear();
  const cache = new LRUCacheClustered<string, string>({ namespace: 'mget-null-norm', max: 10 });
  await cache.set('a', 'A');

  const inner = caches.get('mget-null-norm');
  assert.ok(inner);
  const originalGet = inner.get.bind(inner);
  (inner as { get: (k: string) => unknown }).get = (k) => {
    if (k === 'missing') return null;
    return originalGet(k);
  };

  const got = await cache.mGet(['a', 'missing']);
  assert.equal(got.get('a'), 'A');
  assert.equal(got.has('missing'), true);
  assert.equal(got.get('missing'), undefined);
});

// JSON.stringify(Infinity) === 'null'. lru-cache@11 returns Infinity for
// no-TTL entries; over JSON IPC that becomes null on the wire. Validate the
// normalization restores the documented `Infinity` contract.
void test('getRemainingTTL normalizes null to Infinity (JSON IPC compatibility)', async () => {
  caches.clear();
  const cache = new LRUCacheClustered<string, string>({ namespace: 'rttl-null-norm', max: 10 });
  await cache.set('k', 'v');

  const inner = caches.get('rttl-null-norm');
  assert.ok(inner);
  (inner as { getRemainingTTL: (k: string) => unknown }).getRemainingTTL = () => null;

  const ttl = await cache.getRemainingTTL('k');
  assert.equal(ttl, Infinity);
});

void test('constructor accepts localL1 enabled option', () => {
  const c = new LRUCacheClustered({
    namespace: 'l1-bool',
    max: 10,
    localL1: { enabled: true, experimental: true },
  });
  const stats = c.localStats();
  assert.notEqual(stats, undefined);
  if (stats) {
    assert.equal(stats.enabled, true);
    assert.equal(stats.size, 0);
  }
});

void test('constructor accepts localL1 option (object form)', () => {
  const c = new LRUCacheClustered({
    namespace: 'l1-obj',
    max: 10,
    ttl: 60_000,
    localL1: { enabled: true, experimental: true, max: 100, ttl: 1000 },
  });
  assert.notEqual(c.localStats(), undefined);
});

void test('localL1 disabled by default returns undefined from localStats', () => {
  const c = new LRUCacheClustered({ namespace: 'l1-default', max: 10 });
  assert.equal(c.localStats(), undefined);
});

void test('localL1 enabled=false disables local cache', () => {
  const c = new LRUCacheClustered({
    namespace: 'l1-explicit-disabled',
    max: 10,
    localL1: { enabled: false },
  });
  assert.equal(c.localStats(), undefined);
});

void test('localL1 ttl clamps to primary ttl when greater', () => {
  // Construction succeeds; behaviour is exercised in later tasks.
  const c = new LRUCacheClustered({
    namespace: 'l1-clamp',
    max: 10,
    ttl: 1000,
    localL1: { enabled: true, experimental: true, ttl: 5000 },
  });
  assert.notEqual(c.localStats(), undefined);
});

void test('clearLocal is a no-op when L1 disabled', () => {
  const c = new LRUCacheClustered({ namespace: 'l1-noop' });
  c.clearLocal(); // does not throw
});

void test('clearLocal clears an enabled L1', async () => {
  const c = new LRUCacheClustered<string, number>({
    namespace: 'l1-clear-enabled',
    max: 10,
    localL1: { enabled: true, experimental: true, ttl: 1000 },
  });
  await c.set('a', 1);
  await c.get('a');
  assert.equal(c.localStats()?.size, 1);
  c.clearLocal();
  assert.equal(c.localStats()?.size, 0);
});

void test('invalidateLocal is a no-op when L1 disabled', () => {
  const c = new LRUCacheClustered({ namespace: 'l1-noop-2' });
  c.invalidateLocal('nope'); // does not throw
});

void test('invalidateLocal ignores nullish keys after L1 is enabled', () => {
  const c = new LRUCacheClustered<string, number>({
    namespace: 'l1-nullish-local-key',
    max: 10,
    localL1: { enabled: true, experimental: true, ttl: 1000 },
  });
  assert.doesNotThrow(() => c.invalidateLocal(null as never));
});

void test('get with L1 enabled hits L1 on second read in primary mode', async () => {
  const c = new LRUCacheClustered<string, number>({
    namespace: 'l1-get',
    max: 10,
    localL1: { enabled: true, experimental: true, ttl: 1000 },
  });
  await c.set('a', 1);
  // First read: L1 miss, populates from primary
  const v1 = await c.get('a');
  assert.equal(v1, 1);
  const s1 = c.localStats();
  assert.equal(s1?.hits, 0);
  assert.equal(s1?.misses, 1);

  // Second read: L1 hit
  const v2 = await c.get('a');
  assert.equal(v2, 1);
  const s2 = c.localStats();
  assert.equal(s2?.hits, 1);
  assert.equal(s2?.misses, 1);
  assert.equal(s2?.ipcAvoided, 1);
});

void test('get with bypassL1: true skips L1 entirely', async () => {
  const c = new LRUCacheClustered<string, number>({
    namespace: 'l1-bypass',
    max: 10,
    localL1: { enabled: true, experimental: true, ttl: 1000 },
  });
  await c.set('a', 1);
  await c.get('a'); // populate
  const beforeHits = c.localStats()?.hits;
  await c.get('a', { bypassL1: true });
  // Bypass should NOT increment L1 hits
  assert.equal(c.localStats()?.hits, beforeHits);
});

void test('set with updateL1 populates the caller local cache', async () => {
  const c = new LRUCacheClustered<string, number>({
    namespace: 'l1-set-update',
    max: 10,
    localL1: { enabled: true, experimental: true, ttl: 1000 },
  });
  await c.set('a', 1, { updateL1: true });

  const before = c.localStats()?.hits ?? 0;
  assert.equal(await c.get('a'), 1);
  assert.equal(c.localStats()?.hits, before + 1);
});

void test('get returns undefined for missing key without populating L1', async () => {
  const c = new LRUCacheClustered<string, number>({
    namespace: 'l1-miss',
    max: 10,
    localL1: { enabled: true, experimental: true, ttl: 1000 },
  });
  assert.equal(await c.get('nope'), undefined);
  assert.equal(c.localStats()?.size, 0); // no negative caching in v1
});

void test('L1 skips symbol keys on get and population', async () => {
  const c = new LRUCacheClustered<symbol, number>({
    namespace: 'l1-symbol-get',
    max: 10,
    localL1: { enabled: true, experimental: true, ttl: 1000 },
  });
  const key = Symbol('k');
  await c.set(key, 1);

  assert.equal(await c.get(key), 1);
  assert.equal(c.localStats()?.size, 0);
});

void test('L1 object keys preserve lru-cache identity semantics', async () => {
  const c = new LRUCacheClustered<{ id: number }, string>({
    namespace: 'l1-object-identity',
    max: 10,
    localL1: { enabled: true, experimental: true, ttl: 1000 },
  });
  const a = { id: 1 };
  const b = { id: 1 };
  await c.set(a, 'first');
  await c.set(b, 'second');

  assert.equal(await c.get(a), 'first');
  assert.equal(await c.get(b), 'second');
});

void test('L1 entry TTL is capped by per-write primary TTL', async () => {
  const c = new LRUCacheClustered<string, number>({
    namespace: 'l1-per-entry-ttl',
    max: 10,
    localL1: { enabled: true, experimental: true, ttl: 1000 },
  });
  await c.set('a', 1, { ttl: 20 });
  assert.equal(await c.get('a'), 1); // populate L1 with remaining L2 TTL
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(await c.get('a'), undefined);
});

void test('ttl setter clears L1 and future L1 entries honor the lowered ttl', async () => {
  const c = new LRUCacheClustered<string, number>({
    namespace: 'l1-ttl-setter',
    max: 10,
    ttl: 1000,
    localL1: { enabled: true, experimental: true, ttl: 1000 },
  });
  await c.set('a', 1);
  await c.get('a');
  assert.equal(c.localStats()?.size, 1);

  await c.ttl(20);
  assert.equal(c.localStats()?.size, 0);
  await c.set('b', 2);
  assert.equal(await c.get('b'), 2);
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(await c.get('b'), undefined);
});

void test('max setter clears L1 because primary capacity may evict entries', async () => {
  const c = new LRUCacheClustered<string, number>({
    namespace: 'l1-max-clear',
    max: 2,
    localL1: { enabled: true, experimental: true, ttl: 1000 },
  });
  await c.set('a', 1);
  await c.set('b', 2);
  await c.get('a');
  await c.get('b');
  assert.equal(c.localStats()?.size, 2);
  await c.max(1);
  assert.equal(c.localStats()?.size, 0);
});

void test('set self-invalidates the calling worker L1 entry', async () => {
  const c = new LRUCacheClustered<string, number>({
    namespace: 'l1-self-inv',
    max: 10,
    localL1: { enabled: true, experimental: true, ttl: 1000 },
  });
  await c.set('a', 1);
  await c.get('a'); // populates L1
  assert.equal(c.localStats()?.size, 1);
  await c.set('a', 2); // self-invalidates own L1 first
  // Next read repopulates with fresh value and version
  assert.equal(await c.get('a'), 2);
});

void test('same-process L1 instances invalidate each other', async () => {
  const opts = {
    namespace: 'l1-same-process',
    max: 10,
    localL1: { enabled: true, experimental: true, ttl: 1000 },
  } as const;
  const writer = new LRUCacheClustered<string, number>(opts);
  const reader = new LRUCacheClustered<string, number>(opts);

  await writer.set('a', 1);
  assert.equal(await reader.get('a'), 1); // populate reader L1
  assert.equal(reader.localStats()?.size, 1);
  await writer.set('a', 2);
  assert.equal(await reader.get('a'), 2);
});

void test('has with L1 enabled hits L1 after a populating get', async () => {
  const c = new LRUCacheClustered<string, number>({
    namespace: 'l1-has',
    max: 10,
    localL1: { enabled: true, experimental: true, ttl: 1000 },
  });
  await c.set('a', 1);
  await c.get('a'); // populate
  const before = c.localStats()?.hits ?? 0;
  const r = await c.has('a');
  assert.equal(r, true);
  assert.equal(c.localStats()?.hits, before + 1);
});

void test('peek with L1 enabled hits L1 (peek is a read)', async () => {
  const c = new LRUCacheClustered<string, number>({
    namespace: 'l1-peek',
    max: 10,
    localL1: { enabled: true, experimental: true, ttl: 1000 },
  });
  await c.set('a', 1);
  await c.get('a'); // populate
  const before = c.localStats()?.hits ?? 0;
  const v = await c.peek('a');
  assert.equal(v, 1);
  assert.equal(c.localStats()?.hits, before + 1);
});

void test('peek with L1 enabled populates from primary on miss', async () => {
  const c = new LRUCacheClustered<string, number>({
    namespace: 'l1-peek-populate',
    max: 10,
    localL1: { enabled: true, experimental: true, ttl: 1000 },
  });
  await c.set('a', 1);

  assert.equal(await c.peek('a'), 1);
  assert.equal(c.localStats()?.size, 1);
});

void test('delete self-invalidates and advances latestSeen', async () => {
  const c = new LRUCacheClustered<string, number>({
    namespace: 'l1-del',
    max: 10,
    localL1: { enabled: true, experimental: true, ttl: 1000 },
  });
  await c.set('a', 1);
  await c.get('a');
  await c.delete('a');
  assert.equal(await c.get('a'), undefined);
});

void test('clear wipes the local L1 too', async () => {
  const c = new LRUCacheClustered<string, number>({
    namespace: 'l1-clear',
    max: 10,
    localL1: { enabled: true, experimental: true, ttl: 1000 },
  });
  await c.set('a', 1);
  await c.set('b', 2);
  await c.get('a');
  await c.get('b');
  assert.equal(c.localStats()?.size, 2);
  await c.clear();
  assert.equal(c.localStats()?.size, 0);
});

void test('setIfAbsent self-invalidates regardless of outcome', async () => {
  const c = new LRUCacheClustered<string, number>({
    namespace: 'l1-sia',
    max: 10,
    localL1: { enabled: true, experimental: true, ttl: 1000 },
  });
  await c.set('a', 1);
  await c.get('a'); // populate
  // setIfAbsent on an existing key returns false; should still invalidate own L1
  const r = await c.setIfAbsent('a', 99);
  assert.equal(r, false);
  // Next get bypassing L1 confirms L2 still 1
  const fresh = await c.get('a', { bypassL1: true });
  assert.equal(fresh, 1);
});

void test('mGet with L1 hits each present key in L1 after populate', async () => {
  const c = new LRUCacheClustered<string, number>({
    namespace: 'l1-mget',
    max: 10,
    localL1: { enabled: true, experimental: true, ttl: 1000 },
  });
  await c.set('a', 1);
  await c.set('b', 2);
  await c.mGet(['a', 'b']); // populate both
  const before = c.localStats()?.hits ?? 0;
  const r = await c.mGet(['a', 'b']);
  assert.equal(r.get('a'), 1);
  assert.equal(r.get('b'), 2);
  // Both should hit L1
  assert.equal(c.localStats()?.hits, before + 2);
});

void test('mGet preserves input order when L1 partially hits', async () => {
  const c = new LRUCacheClustered<string, number>({
    namespace: 'l1-mget-order',
    max: 10,
    localL1: { enabled: true, experimental: true, ttl: 1000 },
  });
  await c.mSet([
    ['a', 1],
    ['b', 2],
    ['c', 3],
  ]);
  await c.get('a');
  await c.get('c');

  const r = await c.mGet(['a', 'b', 'c']);
  assert.deepEqual(
    [...r.entries()],
    [
      ['a', 1],
      ['b', 2],
      ['c', 3],
    ],
  );
});

void test('mGet with bypassL1: true skips L1', async () => {
  const c = new LRUCacheClustered<string, number>({
    namespace: 'l1-mget-bypass',
    max: 10,
    localL1: { enabled: true, experimental: true, ttl: 1000 },
  });
  await c.set('a', 1);
  await c.mGet(['a']); // populate
  const before = c.localStats()?.hits ?? 0;
  const r = await c.mGet(['a'], { bypassL1: true });
  assert.equal(r.get('a'), 1);
  assert.equal(c.localStats()?.hits, before);
});

void test('localL1 method subset treats absent methods as disabled', async () => {
  const c = new LRUCacheClustered<string, number>({
    namespace: 'l1-method-subset',
    max: 10,
    localL1: { enabled: true, experimental: true, ttl: 1000, methods: { get: true } },
  });
  await c.set('a', 1);
  await c.get('a');

  const beforeHas = c.localStats()?.hits ?? 0;
  assert.equal(await c.has('a'), true);
  assert.equal(c.localStats()?.hits, beforeHas, 'has did not use L1 when omitted from methods');

  const beforeFetch = c.localStats()?.hits ?? 0;
  assert.equal(await c.fetch('a', () => 2), 1);
  assert.equal(c.localStats()?.hits, beforeFetch, 'fetch did not use L1 when omitted from methods');
});

void test('localL1 methods.fetch can use L1 even when methods.get is disabled', async () => {
  const c = new LRUCacheClustered<string, number>({
    namespace: 'l1-method-fetch-only',
    max: 10,
    localL1: { enabled: true, experimental: true, ttl: 1000, methods: { fetch: true } },
  });
  await c.fetch('a', () => 1);
  const before = c.localStats()?.hits ?? 0;
  assert.equal(await c.fetch('a', () => 2), 1);
  assert.equal(c.localStats()?.hits, before + 1);
});

void test('fetch with L1 enabled populates from an existing primary value', async () => {
  const c = new LRUCacheClustered<string, number>({
    namespace: 'l1-fetch-l2-hit',
    max: 10,
    localL1: { enabled: true, experimental: true, ttl: 1000 },
  });
  await c.set('a', 1);

  assert.equal(await c.fetch('a', () => 2), 1);
  assert.equal(c.localStats()?.size, 1);

  const before = c.localStats()?.hits ?? 0;
  assert.equal(await c.fetch('a', () => 3), 1);
  assert.equal(c.localStats()?.hits, before + 1);
});

void test('localL1 methods.get controls peek and mGet reads', async () => {
  const c = new LRUCacheClustered<string, number>({
    namespace: 'l1-method-get-family',
    max: 10,
    localL1: { enabled: true, experimental: true, ttl: 1000, methods: { fetch: true } },
  });
  await c.fetch('a', () => 1);
  assert.equal(c.localStats()?.size, 1);

  const before = c.localStats()?.hits ?? 0;
  assert.equal(await c.peek('a'), 1);
  assert.equal(c.localStats()?.hits, before, 'peek did not use L1 when get was omitted from methods');

  const values = await c.mGet(['a']);
  assert.equal(values.get('a'), 1);
  assert.equal(c.localStats()?.hits, before, 'mGet did not use L1 when get was omitted from methods');

  assert.equal(await c.fetch('a', () => 2), 1);
  assert.equal(c.localStats()?.hits, before + 1, 'fetch still uses L1 when explicitly enabled');
});

void test('fetch bypassL1 does not piggyback on a stale L1 hit', async () => {
  const namespace = 'l1-fetch-bypass-inflight';
  const reader = new LRUCacheClustered<string, number>({
    namespace,
    max: 10,
    localL1: { enabled: true, experimental: true, ttl: 1000, invalidation: 'ttl-only' },
  });
  const writer = new LRUCacheClustered<string, number>({ namespace, max: 10 });

  await writer.set('a', 1);
  await reader.get('a');
  await writer.set('a', 2);

  const stale = reader.fetch('a', () => 3);
  const fresh = reader.fetch('a', () => 4, { bypassL1: true });

  assert.equal(await stale, 1);
  assert.equal(await fresh, 2);
});

void test('mSet bulk-clears local L1', async () => {
  const c = new LRUCacheClustered<string, number>({
    namespace: 'l1-mset',
    max: 10,
    localL1: { enabled: true, experimental: true, ttl: 1000 },
  });
  await c.set('a', 1);
  await c.get('a'); // populate
  assert.equal(c.localStats()?.size, 1);
  await c.mSet([
    ['b', 2],
    ['c', 3],
  ]);
  assert.equal(c.localStats()?.size, 0);
});

void test('mDelete bulk-clears local L1', async () => {
  const c = new LRUCacheClustered<string, number>({
    namespace: 'l1-mdelete',
    max: 10,
    localL1: { enabled: true, experimental: true, ttl: 1000 },
  });
  await c.mSet([
    ['a', 1],
    ['b', 2],
  ]);
  await c.mGet(['a', 'b']);
  assert.equal(c.localStats()?.size, 2);
  await c.mDelete(['a']);
  assert.equal(c.localStats()?.size, 0);
});

void test('incr self-invalidates own L1 entry on the calling worker', async () => {
  const c = new LRUCacheClustered<string, number>({
    namespace: 'l1-incr',
    max: 10,
    localL1: { enabled: true, experimental: true, ttl: 1000 },
  });
  await c.set('count', 5);
  await c.get('count'); // populate L1 with stale value
  await c.incr('count');
  // Next get must repopulate from primary (the L1 entry was invalidated)
  const v = await c.get('count');
  assert.equal(v, 6);
});

void test('decr self-invalidates own L1 entry on the calling worker', async () => {
  const c = new LRUCacheClustered<string, number>({
    namespace: 'l1-decr',
    max: 10,
    localL1: { enabled: true, experimental: true, ttl: 1000 },
  });
  await c.set('count', 5);
  await c.get('count');
  await c.decr('count');
  assert.equal(await c.get('count'), 4);
});

void test('purgeStale and load clear local L1', async () => {
  const c = new LRUCacheClustered<string, number>({
    namespace: 'l1-purge-load',
    max: 10,
    ttl: 10,
    localL1: { enabled: true, experimental: true, ttl: 1000 },
  });
  await c.set('a', 1);
  await c.get('a');
  assert.equal(c.localStats()?.size, 1);
  await c.load(await c.dump());
  assert.equal(c.localStats()?.size, 0);

  await c.set('b', 2);
  await c.get('b');
  assert.equal(c.localStats()?.size, 1);
  await new Promise((resolve) => setTimeout(resolve, 30));
  await c.purgeStale();
  assert.equal(c.localStats()?.size, 0);
});

void test('withoutLocal() routes reads past L1', async () => {
  const c = new LRUCacheClustered<string, number>({
    namespace: 'l1-without',
    max: 10,
    localL1: { enabled: true, experimental: true, ttl: 1000 },
  });
  await c.set('a', 1);
  await c.get('a'); // populate L1
  const before = c.localStats()?.hits ?? 0;
  const fresh = c.withoutLocal();
  const v = await fresh.get('a');
  assert.equal(v, 1);
  assert.equal(c.localStats()?.hits, before, 'withoutLocal does not register L1 hit');
});

void test('withoutLocal() routes mGet past L1', async () => {
  const c = new LRUCacheClustered<string, number>({
    namespace: 'l1-without-mget',
    max: 10,
    localL1: { enabled: true, experimental: true, ttl: 1000 },
  });
  await c.set('a', 1);
  await c.mGet(['a']); // populate L1
  const before = c.localStats()?.hits ?? 0;
  const fresh = c.withoutLocal();
  const v = await fresh.mGet(['a']);
  assert.equal(v.get('a'), 1);
  assert.equal(c.localStats()?.hits, before);
});

void test('withoutLocal() routes has and peek past L1', async () => {
  const c = new LRUCacheClustered<string, number>({
    namespace: 'l1-without-has-peek',
    max: 10,
    localL1: { enabled: true, experimental: true, ttl: 1000 },
  });
  await c.set('a', 1);
  await c.get('a');

  const before = c.localStats()?.hits ?? 0;
  const fresh = c.withoutLocal();
  assert.equal(await fresh.has('a'), true);
  assert.equal(await fresh.peek('a'), 1);
  assert.equal(c.localStats()?.hits, before);
});

void test('withoutLocal() routes fetch past L1', async () => {
  const namespace = 'l1-without-fetch';
  const reader = new LRUCacheClustered<string, number>({
    namespace,
    max: 10,
    localL1: { enabled: true, experimental: true, ttl: 1000, invalidation: 'ttl-only' },
  });
  const writer = new LRUCacheClustered<string, number>({ namespace, max: 10 });

  await writer.set('a', 1);
  await reader.get('a');
  await writer.set('a', 2);

  const before = reader.localStats()?.hits ?? 0;
  const fresh = reader.withoutLocal();
  assert.equal(await fresh.fetch('a', () => 3), 2);
  assert.equal(reader.localStats()?.hits, before);
});

void test('withoutLocal().set still self-invalidates the underlying L1', async () => {
  const c = new LRUCacheClustered<string, number>({
    namespace: 'l1-without-set',
    max: 10,
    localL1: { enabled: true, experimental: true, ttl: 1000 },
  });
  await c.set('a', 1);
  await c.get('a'); // populate
  const fresh = c.withoutLocal();
  await fresh.set('a', 2);
  // Underlying L1 entry should have been removed by self-invalidate, then
  // re-fetched by the next bypassed read which sees the new L2 value.
  const v = await c.get('a', { bypassL1: true });
  assert.equal(v, 2);
});

void test('withoutLocal() is idempotent', async () => {
  const c = new LRUCacheClustered<string, number>({
    namespace: 'l1-without-idem',
    max: 10,
    localL1: { enabled: true, experimental: true, ttl: 1000 },
  });
  const a = c.withoutLocal();
  const b = a.withoutLocal();
  // The second call returns the same wrapper as the first.
  assert.equal(a, b);
});

void test('withoutLocal() exposes non-function properties from the target', () => {
  const c = new LRUCacheClustered<string, number>({
    namespace: 'l1-without-property',
    max: 10,
    localL1: { enabled: true, experimental: true, ttl: 1000 },
  });
  assert.equal(c.withoutLocal().namespace, 'l1-without-property');
});

void test('l1:hit and l1:miss events fire', async () => {
  const c = new LRUCacheClustered<string, number>({
    namespace: 'l1-events',
    max: 10,
    localL1: { enabled: true, experimental: true, ttl: 1000 },
  });
  const events: Array<{ name: string; payload: unknown }> = [];
  c.on('l1:hit', (p) => events.push({ name: 'l1:hit', payload: p }));
  c.on('l1:miss', (p) => events.push({ name: 'l1:miss', payload: p }));
  await c.set('a', 1);
  await c.get('a'); // miss + populate
  await c.get('a'); // hit
  const names = events.map((e) => e.name);
  assert.ok(names.includes('l1:miss'));
  assert.ok(names.includes('l1:hit'));
  assert.deepEqual(
    events.map((e) => (e.payload as { key?: unknown }).key),
    ['a', 'a'],
  );
});

void test('l1:invalidate event fires on set self-invalidate', async () => {
  const c = new LRUCacheClustered<string, number>({
    namespace: 'l1-inv-evt',
    max: 10,
    localL1: { enabled: true, experimental: true, ttl: 1000 },
  });
  await c.set('a', 1);
  await c.get('a');
  const events: unknown[] = [];
  c.on('l1:invalidate', (p) => events.push(p));
  await c.set('a', 2);
  assert.ok(events.length >= 1);
  assert.deepEqual(
    events.map((event) => (event as { key?: unknown }).key),
    ['a'],
  );
});

void test('broadcast invalidation emits one raw-key event and suppresses internal encoded event', async () => {
  const namespace = 'l1-broadcast-event';
  const reader = new LRUCacheClustered<string, number>({
    namespace,
    max: 10,
    localL1: { enabled: true, experimental: true, ttl: 1000 },
  });
  const writer = new LRUCacheClustered<string, number>({
    namespace,
    max: 10,
    localL1: { enabled: true, experimental: true, ttl: 1000 },
  });
  await writer.set('a', 1);
  await reader.get('a');

  const events: unknown[] = [];
  reader.on('l1:invalidate', (p) => events.push(p));
  await writer.set('a', 2);

  assert.deepEqual(events, [{ namespace, key: 'a', reason: 'broadcast' }]);
});

void test('broadcast invalidation ignores unencodable symbol keys', async () => {
  const namespace = 'l1-broadcast-symbol';
  const reader = new LRUCacheClustered<symbol, number>({
    namespace,
    max: 10,
    localL1: { enabled: true, experimental: true, ttl: 1000 },
  });
  const writer = new LRUCacheClustered<symbol, number>({
    namespace,
    max: 10,
    localL1: { enabled: true, experimental: true, ttl: 1000 },
  });
  const key = Symbol('k');
  const events: unknown[] = [];
  reader.on('l1:invalidate', (p) => events.push(p));

  await assert.doesNotReject(writer.set(key, 1));
  assert.deepEqual(events, [{ namespace, key, reason: 'broadcast' }]);
});

void test('destroy unsubscribes local L1 invalidation listeners', async () => {
  const namespace = 'l1-destroy-unsubscribe';
  const reader = new LRUCacheClustered<string, number>({
    namespace,
    max: 10,
    localL1: { enabled: true, experimental: true, ttl: 1000 },
  });
  const writer = new LRUCacheClustered<string, number>({
    namespace,
    max: 10,
    localL1: { enabled: true, experimental: true, ttl: 1000 },
  });
  await reader.destroy();
  await assert.doesNotReject(writer.set('a', 1));
});

void test('localL1 ttl-only mode ignores same-process broadcast invalidations', async () => {
  const namespace = 'l1-ttl-only';
  const reader = new LRUCacheClustered<string, number>({
    namespace,
    max: 10,
    localL1: { enabled: true, experimental: true, ttl: 1000, invalidation: 'ttl-only' },
  });
  const writer = new LRUCacheClustered<string, number>({
    namespace,
    max: 10,
    localL1: { enabled: true, experimental: true, ttl: 1000 },
  });
  await writer.set('a', 1);
  await reader.get('a');
  await writer.set('a', 2);

  const before = reader.localStats()?.hits ?? 0;
  assert.equal(await reader.get('a'), 1);
  assert.equal(reader.localStats()?.hits, before + 1);
  assert.equal(await reader.get('a', { bypassL1: true }), 2);
});

void test('off() removes a listener', () => {
  const c = new LRUCacheClustered<string, number>({
    namespace: 'l1-off-evt',
    max: 10,
    localL1: { enabled: true, experimental: true, ttl: 1000 },
  });
  let count = 0;
  const handler = () => {
    count += 1;
  };
  c.on('l1:miss', handler);
  c.off('l1:miss', handler);
  // Trigger a miss
  void c.get('nope').catch(() => {});
  assert.equal(count, 0);
});

void test('once() registers a one-shot listener', async () => {
  const c = new LRUCacheClustered<string, number>({
    namespace: 'l1-once-evt',
    max: 10,
    localL1: { enabled: true, experimental: true, ttl: 1000 },
  });
  let count = 0;
  c.once('l1:miss', () => {
    count += 1;
  });

  await c.get('a');
  await c.get('b');
  assert.equal(count, 1);
});

void test('L1 population is skipped when remaining primary ttl cannot be read', async () => {
  const c = new LRUCacheClustered<string, number>({
    namespace: 'l1-remaining-ttl-error',
    max: 10,
    localL1: { enabled: true, experimental: true, ttl: 1000 },
  });
  await c.set('a', 1);
  c.getRemainingTTL = async () => {
    throw new Error('ttl failed');
  };

  assert.equal(await c.get('a'), 1);
  assert.equal(c.localStats()?.size, 0);
});

void test('L1 population is skipped when remaining primary ttl is unavailable', async () => {
  const c = new LRUCacheClustered<string, number>({
    namespace: 'l1-remaining-ttl-undefined',
    max: 10,
    localL1: { enabled: true, experimental: true, ttl: 1000 },
  });
  await c.set('a', 1);
  c.getRemainingTTL = async () => undefined as unknown as number;

  assert.equal(await c.get('a'), 1);
  assert.equal(c.localStats()?.size, 0);
});

void test('localL1 enabled without experimental: true throws', () => {
  assert.throws(
    () =>
      new LRUCacheClustered({
        namespace: 'l1-gated',
        max: 10,
        localL1: { enabled: true, ttl: 1000 },
      }),
    /experimental/i,
  );
});

void test('localL1 enabled with experimental: true works', () => {
  const c = new LRUCacheClustered({
    namespace: 'l1-gated-ok',
    max: 10,
    localL1: { enabled: true, experimental: true, ttl: 1000 },
  });
  assert.notEqual(c.localStats(), undefined);
});
