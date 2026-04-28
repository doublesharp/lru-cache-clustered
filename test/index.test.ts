import test from 'node:test';
import assert from 'node:assert/strict';
import { LRUCacheForClustersAsPromised } from '../src/index.ts';
import { caches } from '../src/primary.ts';

void test('primary-mode set/get/delete round-trip', async () => {
  caches.clear();
  const cache = new LRUCacheForClustersAsPromised<string, string>({ namespace: 'idx-1', max: 10 });
  await cache.set('k', 'v');
  assert.equal(await cache.get('k'), 'v');
  assert.equal(await cache.has('k'), true);
  assert.equal(await cache.delete('k'), true);
  assert.equal(await cache.get('k'), undefined);
});

void test('primary-mode mGet/mSet/mDelete', async () => {
  caches.clear();
  const cache = new LRUCacheForClustersAsPromised<string, number>({ namespace: 'idx-2', max: 10 });
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
  const cache = new LRUCacheForClustersAsPromised<string, number>({ namespace: 'idx-3' });
  assert.equal(await cache.incr('hits'), 1);
  assert.equal(await cache.incr('hits', 4), 5);
  assert.equal(await cache.decr('hits'), 4);
});

void test('primary-mode size, keys, values, entries, clear', async () => {
  caches.clear();
  const cache = new LRUCacheForClustersAsPromised<string, number>({ namespace: 'idx-4', max: 10 });
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

void test('primary-mode config getters/setters', async () => {
  caches.clear();
  const cache = new LRUCacheForClustersAsPromised<string, number>({ namespace: 'idx-5', max: 10, ttl: 1000 });
  assert.equal(await cache.max(), 10);
  assert.equal(await cache.max(50), 50);
  assert.equal(await cache.ttl(), 1000);
  assert.equal(await cache.ttl(2000), 2000);
  assert.equal(await cache.allowStale(), false);
  assert.equal(await cache.allowStale(true), true);
});

void test('namespace isolation between instances', async () => {
  caches.clear();
  const a = new LRUCacheForClustersAsPromised({ namespace: 'iso-a' });
  const b = new LRUCacheForClustersAsPromised({ namespace: 'iso-b' });
  await a.set('k', 'A');
  await b.set('k', 'B');
  assert.equal(await a.get('k'), 'A');
  assert.equal(await b.get('k'), 'B');
});

void test('getInstance resolves to a usable cache', async () => {
  caches.clear();
  const cache = await LRUCacheForClustersAsPromised.getInstance<string, string>({ namespace: 'gi', max: 5 });
  await cache.set('x', 'y');
  assert.equal(await cache.get('x'), 'y');
});

void test('getAllCaches returns the registry on primary', async () => {
  caches.clear();
  new LRUCacheForClustersAsPromised({ namespace: 'gac', max: 5 });
  const all = LRUCacheForClustersAsPromised.getAllCaches();
  assert.ok(all instanceof Map);
  assert.ok(all.has('gac'));
});

void test('getCache returns the underlying lru-cache instance on primary', async () => {
  caches.clear();
  const cache = new LRUCacheForClustersAsPromised<string, string>({ namespace: 'gc', max: 5 });
  await cache.set('a', 'b');
  const inner = cache.getCache();
  assert.ok(inner);
  assert.equal((inner as { get: (k: string) => unknown }).get('a'), 'b');
});

void test('peek does not promote, dump and purgeStale work', async () => {
  caches.clear();
  const cache = new LRUCacheForClustersAsPromised<string, string>({ namespace: 'pdp', max: 3 });
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
  const cache = new LRUCacheForClustersAsPromised<string, string>({ namespace: 'ttl-opt', max: 10 });
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

void test('options defaults and explicit failsafe=reject', () => {
  caches.clear();
  const cdef = new LRUCacheForClustersAsPromised();
  assert.equal(cdef.namespace, 'default');
  assert.equal(cdef.timeout, 100);
  assert.equal(cdef.failsafe, 'resolve');

  const ccustom = new LRUCacheForClustersAsPromised({
    namespace: 'cn',
    timeout: 250,
    failsafe: 'reject',
  });
  assert.equal(ccustom.namespace, 'cn');
  assert.equal(ccustom.timeout, 250);
  assert.equal(ccustom.failsafe, 'reject');
});

void test('dispatch rejects when handler throws', async () => {
  caches.clear();
  const cache = new LRUCacheForClustersAsPromised<string, string>({
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

void test('ready resolves to undefined in primary mode', async () => {
  caches.clear();
  const cache = new LRUCacheForClustersAsPromised<string, string>({ namespace: 'ready-1' });
  assert.equal(await cache.ready, undefined);
});

void test('getRemainingTTL returns a number consistent with ttl presence', async () => {
  caches.clear();
  const cache = new LRUCacheForClustersAsPromised<string, string>({ namespace: 'rt-1', max: 10 });
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
  const cache = new LRUCacheForClustersAsPromised<string, string>({ namespace: 'sia-1', max: 10 });
  assert.equal(await cache.setIfAbsent('k', 'first'), true);
  assert.equal(await cache.setIfAbsent('k', 'second'), false);
  assert.equal(await cache.get('k'), 'first');
});

void test('setIfAbsent honors ttl on first set', async () => {
  caches.clear();
  const cache = new LRUCacheForClustersAsPromised<string, string>({ namespace: 'sia-2', max: 10 });
  assert.equal(await cache.setIfAbsent('k', 'v', { ttl: 50_000 }), true);
  const ttl = await cache.getRemainingTTL('k');
  assert.ok(ttl > 0 && ttl <= 50_000);
});

void test('load restores a previously dumped cache', async () => {
  caches.clear();
  const cache = new LRUCacheForClustersAsPromised<string, string>({ namespace: 'load-1', max: 10 });
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
  const cache = new LRUCacheForClustersAsPromised<string, string>({ namespace: 'stats-1', max: 10 });
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
  const cache = new LRUCacheForClustersAsPromised<string, number>({ namespace: 'incr-ttl', max: 10 });
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
  const cache = new LRUCacheForClustersAsPromised<string, number>({ namespace: 'aiter-1', max: 10 });
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
  const cache = new LRUCacheForClustersAsPromised<string, string>({ namespace: 'fetch-1', max: 10 });
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

void test('fetch with forceRefresh re-invokes fetcher', async () => {
  caches.clear();
  const cache = new LRUCacheForClustersAsPromised<string, number>({ namespace: 'fetch-2', max: 10 });
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

void test('fetch propagates fetcher errors and clears in-flight slot', async () => {
  caches.clear();
  const cache = new LRUCacheForClustersAsPromised<string, string>({ namespace: 'fetch-3', max: 10 });
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
