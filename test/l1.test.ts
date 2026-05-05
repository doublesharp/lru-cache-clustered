import test from 'node:test';
import assert from 'node:assert/strict';
import { LocalL1Cache, encodeL1Key } from '../src/l1.ts';
import { LRUCacheClustered } from '../src/index.ts';

void test('encodeL1Key handles primitives and objects', () => {
  assert.equal(encodeL1Key('a'), 's:a');
  assert.equal(encodeL1Key(42), 'n:42');
  // Object keys serialize to JSON
  assert.equal(encodeL1Key({ x: 1 }), 'o:{"x":1}');
  // Symbol is rejected
  const sym = Symbol('s');
  assert.throws(() => encodeL1Key(sym), /symbol/i);
});

void test('LocalL1Cache get returns undefined for missing key, hit for matching version', () => {
  const l1 = new LocalL1Cache({ max: 10, ttl: 1000 });
  assert.equal(l1.get('s:a'), undefined);
  l1.set('s:a', 'v', 1);
  assert.equal(l1.get('s:a'), 'v');
  // After advancing latest-seen past the entry's version, the read drops it
  l1.advanceLatestSeen(2);
  assert.equal(l1.get('s:a'), undefined);
});

void test('LocalL1Cache deletes a single entry', () => {
  const l1 = new LocalL1Cache({ max: 10, ttl: 1000 });
  l1.set('s:a', 'v', 1);
  l1.set('s:b', 'w', 1);
  l1.delete('s:a');
  assert.equal(l1.get('s:a'), undefined);
  assert.equal(l1.get('s:b'), 'w');
});

void test('LocalL1Cache clear removes everything', () => {
  const l1 = new LocalL1Cache({ max: 10, ttl: 1000 });
  l1.set('s:a', 'v', 1);
  l1.set('s:b', 'w', 1);
  l1.clear();
  assert.equal(l1.get('s:a'), undefined);
  assert.equal(l1.get('s:b'), undefined);
});

void test('LocalL1Cache stats track hits, misses, sets, invalidations', () => {
  const l1 = new LocalL1Cache({ max: 10, ttl: 1000 });
  l1.set('s:a', 'v', 1);
  l1.get('s:a'); // hit
  l1.get('s:b'); // miss
  l1.delete('s:a'); // invalidation +1
  const s = l1.stats();
  assert.equal(s.hits, 1);
  assert.equal(s.misses, 1);
  assert.equal(s.sets, 1);
  assert.equal(s.invalidations, 1);
});

void test('LocalL1Cache TTL expires entries', async () => {
  const l1 = new LocalL1Cache({ max: 10, ttl: 50 });
  l1.set('s:a', 'v', 1);
  assert.equal(l1.get('s:a'), 'v');
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(l1.get('s:a'), undefined);
});

void test('worker-mode L1 reacts to invalidateLocal (proxy for the broadcast handler effect)', async () => {
  // We can't easily mock cluster.isWorker in primary mode; the cross-worker
  // behaviour is exercised in cluster tests (Task 13). This unit test just
  // verifies that invalidateLocal performs the expected L1 mutation.
  const c = new LRUCacheClustered<string, number>({
    namespace: 'l1-sub',
    max: 10,
    localL1: { enabled: true, experimental: true, ttl: 1000 },
  });
  await c.set('a', 1);
  await c.get('a'); // populate
  assert.equal(c.localStats()?.size, 1);
  c.invalidateLocal('a');
  assert.equal(c.localStats()?.size, 0);
});

void test('fetch leader populates own L1 after fetcher success', async () => {
  const c = new LRUCacheClustered<string, number>({
    namespace: 'l1-fetch',
    max: 10,
    localL1: { enabled: true, experimental: true, ttl: 1000 },
  });
  let calls = 0;
  const v = await c.fetch('k', async () => {
    calls += 1;
    return 42;
  });
  assert.equal(v, 42);
  // After fetch, L1 should hold the value
  assert.equal(c.localStats()?.size, 1);
  // Second fetch should hit L1 (no fetcher call)
  const v2 = await c.fetch('k', async () => {
    calls += 1;
    return 999;
  });
  assert.equal(v2, 42);
  assert.equal(calls, 1);
});

void test('fetch with bypassL1 forces a primary read but still single-flights', async () => {
  const c = new LRUCacheClustered<string, number>({
    namespace: 'l1-fetch-bypass',
    max: 10,
    localL1: { enabled: true, experimental: true, ttl: 1000 },
  });
  let calls = 0;
  await c.fetch('k', async () => {
    calls += 1;
    return 1;
  });
  // bypass should still see the L2 value via the primary `get`
  const v = await c.fetch(
    'k',
    async () => {
      calls += 1;
      return 2;
    },
    { bypassL1: true },
  );
  assert.equal(v, 1);
  assert.equal(calls, 1); // L2 hit, no second fetcher call
});
