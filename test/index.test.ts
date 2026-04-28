import test from 'node:test';
import assert from 'node:assert/strict';
import { LRUCacheForClustersAsPromised } from '../src/index.ts';
import { caches } from '../src/primary.ts';

test('primary-mode set/get/delete round-trip', async () => {
  caches.clear();
  const cache = new LRUCacheForClustersAsPromised<string, string>({ namespace: 'idx-1', max: 10 });
  await cache.set('k', 'v');
  assert.equal(await cache.get('k'), 'v');
  assert.equal(await cache.has('k'), true);
  assert.equal(await cache.delete('k'), true);
  assert.equal(await cache.get('k'), undefined);
});

test('primary-mode mGet/mSet/mDelete', async () => {
  caches.clear();
  const cache = new LRUCacheForClustersAsPromised<string, number>({ namespace: 'idx-2', max: 10 });
  await cache.mSet([['a', 1], ['b', 2]]);
  const got = await cache.mGet(['a', 'b', 'c']);
  assert.deepEqual([...got.entries()], [['a', 1], ['b', 2], ['c', undefined]]);
  await cache.mDelete(['a']);
  assert.equal(await cache.get('a'), undefined);
});

test('primary-mode incr/decr', async () => {
  caches.clear();
  const cache = new LRUCacheForClustersAsPromised<string, number>({ namespace: 'idx-3' });
  assert.equal(await cache.incr('hits'), 1);
  assert.equal(await cache.incr('hits', 4), 5);
  assert.equal(await cache.decr('hits'), 4);
});

test('primary-mode size, keys, values, entries, clear', async () => {
  caches.clear();
  const cache = new LRUCacheForClustersAsPromised<string, number>({ namespace: 'idx-4', max: 10 });
  await cache.set('a', 1);
  await cache.set('b', 2);
  assert.equal(await cache.size(), 2);
  assert.deepEqual(await cache.keys(), ['b', 'a']);
  assert.deepEqual(await cache.values(), [2, 1]);
  assert.deepEqual(await cache.entries(), [['b', 2], ['a', 1]]);
  await cache.clear();
  assert.equal(await cache.size(), 0);
});

test('primary-mode config getters/setters', async () => {
  caches.clear();
  const cache = new LRUCacheForClustersAsPromised<string, number>({ namespace: 'idx-5', max: 10, ttl: 1000 });
  assert.equal(await cache.max(), 10);
  assert.equal(await cache.max(50), 50);
  assert.equal(await cache.ttl(), 1000);
  assert.equal(await cache.ttl(2000), 2000);
  assert.equal(await cache.allowStale(), false);
  assert.equal(await cache.allowStale(true), true);
});

test('namespace isolation between instances', async () => {
  caches.clear();
  const a = new LRUCacheForClustersAsPromised({ namespace: 'iso-a' });
  const b = new LRUCacheForClustersAsPromised({ namespace: 'iso-b' });
  await a.set('k', 'A');
  await b.set('k', 'B');
  assert.equal(await a.get('k'), 'A');
  assert.equal(await b.get('k'), 'B');
});

test('getInstance resolves to a usable cache', async () => {
  caches.clear();
  const cache = await LRUCacheForClustersAsPromised.getInstance<string, string>({ namespace: 'gi', max: 5 });
  await cache.set('x', 'y');
  assert.equal(await cache.get('x'), 'y');
});

test('getAllCaches returns the registry on primary', async () => {
  caches.clear();
  new LRUCacheForClustersAsPromised({ namespace: 'gac', max: 5 });
  const all = LRUCacheForClustersAsPromised.getAllCaches();
  assert.ok(all instanceof Map);
  assert.ok(all.has('gac'));
});

test('getCache returns the underlying lru-cache instance on primary', async () => {
  caches.clear();
  const cache = new LRUCacheForClustersAsPromised<string, string>({ namespace: 'gc', max: 5 });
  await cache.set('a', 'b');
  const inner = cache.getCache();
  assert.ok(inner);
  assert.equal((inner as { get: (k: string) => unknown }).get('a'), 'b');
});
