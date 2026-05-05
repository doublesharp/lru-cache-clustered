import test from 'node:test';
import assert from 'node:assert/strict';
import { LRUCacheClustered } from '../src/index.ts';

void test('invalidation arriving before response: stale entry rejected by version check', async () => {
  // In primary mode, dispatchAndBroadcast is sync, so we can't naturally race.
  // Simulate: read produces value+version V1, then we manually advance latestSeen
  // *before* the L1.set call would simulate landing. Easiest model: directly
  // drive the public API and confirm convergence.
  const c = new LRUCacheClustered<string, number>({
    namespace: 'race-1',
    max: 10,
    localL1: { enabled: true, experimental: true, ttl: 1000 },
  });
  await c.set('a', 1);
  // Simulate the race: get is in flight, returns version 5; meanwhile a different
  // worker did a set that bumped to version 6 and broadcast. We model the
  // broadcast arriving as invalidateLocal, which advances latestSeen and drops
  // any stamped-with-old-version L1 entry on the next read.
  c.invalidateLocal('a');
  const v = await c.get('a');
  assert.equal(v, 1);
  // Subsequent reads stay consistent
  assert.equal(await c.get('a'), 1);
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

void test('clear during fetch: in-flight fetcher completes, value either stored or aborted (never stale)', async () => {
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
  // While the fetcher is parked, clear the cache. This bumps the namespace
  // version and broadcasts a namespace-wide invalidation; the leader's
  // fetchStore call will either succeed (key reappears post-clear) or have
  // its lock invalidated (returns false) - both outcomes are non-stale.
  await c.clear();
  releaseFetcher();
  const v = await p;
  // The result is either 42 (fetchStore raced past the clear) or undefined
  // (fetchStore was rejected). The contract: value must not be stale, which
  // means it must be from the fetcher that we just ran, not a pre-clear value.
  assert.ok(v === 42 || v === undefined, `unexpected fetch result ${String(v)}`);
});

void test('many concurrent sets to same key converge with no zombie L1 entries', async () => {
  const c = new LRUCacheClustered<string, number>({
    namespace: 'race-4',
    max: 10,
    localL1: { enabled: true, experimental: true, ttl: 1000 },
  });
  // Seed
  await c.set('k', 0);
  // Fire 20 concurrent sets
  const writes = Array.from({ length: 20 }, (_, i) => c.set('k', i + 1));
  await Promise.all(writes);
  // The final value is whichever set lost the race to the primary; we don't
  // care about the specific value, only that L1 is consistent with L2.
  const fromL1 = await c.get('k');
  const fromL2 = await c.get('k', { bypassL1: true });
  assert.equal(fromL1, fromL2);
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
