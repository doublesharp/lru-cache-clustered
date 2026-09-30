import test from 'node:test';
import assert from 'node:assert/strict';
import { LRUCacheClustered } from '../src/index.ts';

void test('reusing a destroyed instance restores local invalidation subscriptions', async () => {
  const options = { namespace: 'l1-reused-after-destroy', max: 10 };
  const reader = new LRUCacheClustered<string, number>({
    ...options,
    localL1: { experimental: true, ttl: 5000 },
  });
  const writer = new LRUCacheClustered<string, number>(options);
  await reader.set('key', 1);
  assert.equal(await reader.destroy(), true);
  await writer.set('key', 2);
  assert.equal(await reader.get('key'), 2);
  assert.equal(await reader.get('key'), 2);
  assert.equal(reader.localStats()?.hits, 1, 'the reused instance has a warm L1');
  await writer.set('key', 3);
  assert.equal(reader.localStats()?.size, 0, 'the other instance must invalidate the reused reader');
  assert.equal(await reader.get('key'), 3);
  await reader.destroy();
});

void test('invalidation arriving before a read continuation prevents stale L1 population', async () => {
  const namespace = 'race-1';
  const reader = new LRUCacheClustered<string, number>({
    namespace,
    max: 10,
    localL1: { experimental: true, ttl: 1000 },
  });
  const writer = new LRUCacheClustered<string, number>({ namespace, max: 10 });
  await writer.set('a', 1);
  const pending = reader.get('a'); // primary snapshot is 1; continuation has not populated L1
  const write = writer.set('a', 2); // invalidation arrives before that continuation
  assert.equal(await pending, 1);
  await write;
  assert.equal(reader.localStats()?.size, 0, 'the old response must not repopulate L1');
  assert.equal(await reader.get('a'), 2);
  assert.equal(await reader.get('a'), 2);
  assert.equal(reader.localStats()?.hits, 1);
});

void test('rapid set/delete/set on same key: final state is the last write', async () => {
  const c = new LRUCacheClustered<string, number>({
    namespace: 'race-2',
    max: 10,
    localL1: { enabled: true, experimental: true, ttl: 1000 },
  });
  for (let i = 0; i < 50; i++) {
    await c.set('k', i);
    await c.delete('k');
    await c.set('k', i + 1000);
  }
  const v = await c.get('k');
  assert.equal(v, 1049);
});

void test('clear during fetch permits the active fetcher to store its result after clear', async () => {
  const c = new LRUCacheClustered<string, number>({
    namespace: 'race-3',
    max: 10,
    localL1: { enabled: true, experimental: true, ttl: 1000 },
  });
  let fetcherStarted: () => void = () => {};
  const started = new Promise<void>((r) => {
    fetcherStarted = r;
  });
  let releaseFetcher: () => void = () => {};
  const release = new Promise<void>((r) => {
    releaseFetcher = r;
  });

  const p = c.fetch('k', async () => {
    fetcherStarted();
    await release;
    return 42;
  });

  await started;
  await c.clear();
  assert.equal(await c.get('k', { bypassL1: true }), undefined);
  releaseFetcher();
  assert.equal(await p, 42);
  assert.equal(await c.get('k'), 42);
  assert.equal(await c.get('k', { bypassL1: true }), 42);
});

void test('many concurrent sets to same key converge with no zombie L1 entries', async () => {
  const c = new LRUCacheClustered<string, number>({
    namespace: 'race-4',
    max: 10,
    localL1: { enabled: true, experimental: true, ttl: 1000 },
  });
  // Seed
  await c.set('k', 0);
  assert.equal(await c.get('k'), 0);
  assert.equal(await c.get('k'), 0);
  assert.equal(c.localStats()?.hits, 1, 'L1 is warm before concurrent writes');
  // Fire 20 concurrent sets
  const writes = Array.from({ length: 20 }, (_, i) => c.set('k', i + 1));
  await Promise.all(writes);
  // Primary dispatch is synchronous: these writes arrive in array order.
  const fromL1 = await c.get('k');
  const fromL2 = await c.get('k', { bypassL1: true });
  assert.equal(fromL1, 20);
  assert.equal(fromL2, 20);
  assert.equal(await c.get('k'), 20);
  assert.equal(c.localStats()?.hits, 2);
});

void test('concurrent fetch from same instance dedups via inFlight slot', async () => {
  const c = new LRUCacheClustered<string, number>({
    namespace: 'race-5',
    max: 10,
    localL1: { enabled: true, experimental: true, ttl: 1000 },
  });
  let fetcherCalls = 0;
  // 10 concurrent fetches with the same key on the same instance
  const promises = Array.from({ length: 10 }, () =>
    c.fetch('k', async () => {
      fetcherCalls += 1;
      // Slight async delay
      await new Promise((r) => setTimeout(r, 10));
      return 7;
    }),
  );
  const results = await Promise.all(promises);
  assert.equal(fetcherCalls, 1, 'in-flight slot should dedup all 10 calls');
  for (const r of results) assert.equal(r, 7);
});
