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
