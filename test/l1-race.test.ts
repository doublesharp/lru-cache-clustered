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

void test('clear during fetch rejects the superseded result without repopulating', async () => {
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
  await assert.rejects(p, /superseded.*no current value/i);
  assert.equal(await c.get('k'), undefined);
  assert.equal(await c.get('k', { bypassL1: true }), undefined);
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

void test('single-key mutations preserve unrelated warm L1 hits', async () => {
  const options = { namespace: 'l1-targeted-warm', max: 100 };
  const reader = new LRUCacheClustered<string, number>({ ...options, localL1: { experimental: true } });
  const writer = new LRUCacheClustered<string, number>(options);
  await writer.set('hot', 1);
  await reader.get('hot');
  await writer.set('other', 2);
  assert.equal(await reader.get('hot'), 1);
  assert.equal(reader.localStats()?.hits, 1, 'unrelated writes preserve the hot hit');
  await reader.set('self-other', 3);
  assert.equal(await reader.get('hot'), 1);
  assert.equal(reader.localStats()?.hits, 2, 'self writes are targeted too');
  await reader.destroy();
});

for (const operation of ['get', 'peek', 'mGet', 'fetch', 'set'] as const) {
  void test(`local invalidation fences a pending ${operation} population`, async () => {
    const cache = new LRUCacheClustered<string, number>({
      namespace: `l1-local-pending-${operation}`,
      max: 10,
      localL1: { experimental: true },
    });
    await cache.set('k', 1);
    const pending =
      operation === 'mGet'
        ? cache.mGet(['k'])
        : operation === 'fetch'
          ? cache.fetch('k', () => 2)
          : operation === 'set'
            ? cache.set('k', 2, { updateL1: true })
            : cache[operation]('k');
    cache.invalidateLocal('k');
    await pending;
    assert.equal(cache.localStats()?.size, 0, 'an earlier response cannot undo invalidateLocal');
    await cache.destroy();
  });
}

for (const invalidation of ['broadcast', 'ttl-only'] as const) {
  for (const mutate of ['set', 'delete', 'clear', 'destroy'] as const) {
    void test(`${invalidation} self ${mutate} fences a pending read`, async () => {
      const cache = new LRUCacheClustered<string, number>({
        namespace: `l1-self-fence-${invalidation}-${mutate}`,
        max: 10,
        localL1: { experimental: true, invalidation },
      });
      await cache.set('key', 1);
      const pending = cache.get('key');
      const mutation =
        mutate === 'set' ? cache.set('key', 2) : mutate === 'delete' ? cache.delete('key') : cache[mutate]();
      assert.equal(await pending, 1, 'an already captured read may return its snapshot');
      await mutation;
      assert.equal(cache.localStats()?.size, 0, 'the snapshot must not repopulate L1');
      assert.equal(await cache.get('key'), mutate === 'set' ? 2 : undefined);
      await cache.destroy();
    });
  }
}

for (const operation of ['get', 'peek', 'mGet', 'fetch', 'set'] as const) {
  void test(`a newer same-key write fences pending ${operation} population`, async () => {
    const options = { namespace: `l1-pending-newer-${operation}`, max: 10 };
    const reader = new LRUCacheClustered<string, number>({ ...options, localL1: { experimental: true } });
    const writer = new LRUCacheClustered<string, number>(options);
    await writer.set('key', 1);
    const pending =
      operation === 'mGet'
        ? reader.mGet(['key', 'key'])
        : operation === 'fetch'
          ? reader.fetch('key', () => 2)
          : operation === 'set'
            ? reader.set('key', 2, { updateL1: true })
            : reader[operation]('key');
    const mutation = writer.set('key', 3);
    await pending;
    await mutation;
    assert.equal(reader.localStats()?.size, 0);
    assert.equal(await reader.get('key'), 3);
    await reader.destroy();
  });

  void test(`destroy and recreation fence pending ${operation} population`, async () => {
    const options = { namespace: `l1-pending-generation-${operation}`, max: 10 };
    const reader = new LRUCacheClustered<string, number>({ ...options, localL1: { experimental: true } });
    const writer = new LRUCacheClustered<string, number>(options);
    await writer.set('key', 1);
    const pending =
      operation === 'mGet'
        ? reader.mGet(['key'])
        : operation === 'fetch'
          ? reader.fetch('key', () => 2)
          : operation === 'set'
            ? reader.set('key', 2, { updateL1: true })
            : reader[operation]('key');
    const destroy = writer.destroy();
    const recreate = writer.set('key', 3);
    await Promise.all([pending, destroy, recreate]);
    assert.equal(reader.localStats()?.size, 0);
    assert.equal(await reader.get('key'), 3);
    await reader.destroy();
  });
}

for (const mutation of ['set', 'delete', 'clear', 'destroy'] as const) {
  void test(`fetch completion respects an intervening ${mutation}`, async () => {
    const options = { namespace: `l1-fetch-superseded-${mutation}`, max: 10 };
    const reader = new LRUCacheClustered<string, number>({ ...options, localL1: { experimental: true } });
    const writer = new LRUCacheClustered<string, number>(options);
    let release!: () => void;
    let enter!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      enter = resolve;
    });
    const pending = reader.fetch('key', async () => {
      enter();
      await gate;
      return 1;
    });
    await started;
    if (mutation === 'set') await writer.set('key', 2);
    else if (mutation === 'delete') await writer.delete('key');
    else await writer[mutation]();
    release();
    if (mutation === 'set') assert.equal(await pending, 2, 'the newer authoritative value wins');
    else await assert.rejects(pending, /superseded.*no current value/i);
    assert.equal(await reader.get('key', { bypassL1: true }), mutation === 'set' ? 2 : undefined);
    await reader.destroy();
  });
}

void test('finishing a destroyed namespace fetch does not recreate the namespace', async () => {
  const namespace = 'l1-fetch-destroy-no-recreation';
  const cache = new LRUCacheClustered<string, number>({ namespace, max: 10 });
  let enter!: () => void;
  let release!: () => void;
  const started = new Promise<void>((resolve) => {
    enter = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const pending = cache.fetch('key', async () => {
    enter();
    await gate;
    return 1;
  });
  await started;
  await cache.destroy();
  assert.equal(LRUCacheClustered.getAllCaches().has(namespace), false);
  release();
  await assert.rejects(pending, /superseded.*no current value/i);
  assert.equal(
    LRUCacheClustered.getAllCaches().has(namespace),
    false,
    'fetch completion must preserve namespace destruction',
  );
});

void test('a throwing invalidation listener cannot retain a stale L1 entry', async () => {
  const options = { namespace: 'l1-throwing-invalidation-listener', max: 10 };
  const reader = new LRUCacheClustered<string, number>({ ...options, localL1: { experimental: true } });
  const writer = new LRUCacheClustered<string, number>(options);
  await writer.set('key', 1);
  await reader.get('key');
  reader.on('l1:invalidate', () => {
    throw new Error('consumer listener failed');
  });
  await writer.set('key', 2);
  assert.equal(await reader.get('key'), 2, 'listener failure cannot prevent invalidation');
  await writer.destroy();
});
