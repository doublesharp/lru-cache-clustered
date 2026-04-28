import test from 'node:test';
import assert from 'node:assert/strict';
import { LRUCacheForClustersAsPromised } from '../src/index.ts';
import { memoize } from '../src/memoize.ts';
import { caches } from '../src/primary.ts';

void test('memoize returns cached value on subsequent calls', async () => {
  caches.clear();
  const cache = new LRUCacheForClustersAsPromised<string, number>({ namespace: 'memo-1', max: 10 });
  let calls = 0;
  const fn = (n: number) => {
    calls += 1;
    return n * 2;
  };
  const memo = memoize(cache, fn, (n: number) => `n:${n}`);

  assert.equal(await memo(3), 6);
  assert.equal(await memo(3), 6);
  assert.equal(await memo(3), 6);
  assert.equal(calls, 1);
});

void test('memoize dedups concurrent calls for the same key', async () => {
  caches.clear();
  const cache = new LRUCacheForClustersAsPromised<string, number>({ namespace: 'memo-2', max: 10 });
  let calls = 0;
  const fn = async (n: number) => {
    calls += 1;
    // Force overlap so all 5 callers attach to the same in-flight promise.
    await new Promise((resolve) => setTimeout(resolve, 10));
    return n + 100;
  };
  const memo = memoize(cache, fn, (n: number) => `n:${n}`);

  const results = await Promise.all([memo(1), memo(1), memo(1), memo(1), memo(1)]);

  assert.deepEqual(results, [101, 101, 101, 101, 101]);
  assert.equal(calls, 1);
});

void test('memoize calls fn independently for different keys', async () => {
  caches.clear();
  const cache = new LRUCacheForClustersAsPromised<string, number>({ namespace: 'memo-3', max: 10 });
  let calls = 0;
  const fn = (n: number) => {
    calls += 1;
    return n * 10;
  };
  const memo = memoize(cache, fn, (n: number) => `n:${n}`);

  assert.equal(await memo(1), 10);
  assert.equal(await memo(2), 20);
  assert.equal(await memo(3), 30);
  assert.equal(calls, 3);
});

void test('memoize honors ttl on the underlying set', async () => {
  caches.clear();
  const cache = new LRUCacheForClustersAsPromised<string, number>({ namespace: 'memo-4', max: 10 });
  let calls = 0;
  const fn = (n: number) => {
    calls += 1;
    return n + 1;
  };
  const memo = memoize(cache, fn, (n: number) => `k:${n}`, { ttl: 20 });

  assert.equal(await memo(5), 6);
  assert.equal(calls, 1);

  // Verify the entry exists immediately after set.
  assert.equal(await cache.get('k:5'), 6);

  // Wait past ttl — the entry should expire and fn should be invoked again.
  await new Promise((resolve) => setTimeout(resolve, 50));

  assert.equal(await memo(5), 6);
  assert.equal(calls, 2);
});

void test('memoize propagates errors and clears in-flight slot', async () => {
  caches.clear();
  const cache = new LRUCacheForClustersAsPromised<string, string>({ namespace: 'memo-5', max: 10 });
  let calls = 0;
  let shouldThrow = true;
  const fn = async (label: string) => {
    calls += 1;
    if (shouldThrow) {
      throw new Error(`boom:${label}`);
    }
    return `ok:${label}`;
  };
  const memo = memoize(cache, fn, (label: string) => label);

  await assert.rejects(() => memo('a'), /boom:a/);
  assert.equal(calls, 1);

  // Cache must not be populated on error.
  assert.equal(await cache.get('a'), undefined);

  // Subsequent call retries (in-flight slot was cleared).
  shouldThrow = false;
  assert.equal(await memo('a'), 'ok:a');
  assert.equal(calls, 2);
  assert.equal(await cache.get('a'), 'ok:a');
});

void test('memoize keyFn receives the original args', async () => {
  caches.clear();
  const cache = new LRUCacheForClustersAsPromised<string, string>({ namespace: 'memo-6', max: 10 });
  const seen: Array<[number, string]> = [];
  const fn = (a: number, b: string) => `${a}-${b}`;
  const memo = memoize(cache, fn, (a: number, b: string) => {
    seen.push([a, b]);
    return `${a}|${b}`;
  });

  assert.equal(await memo(1, 'x'), '1-x');
  assert.equal(await memo(2, 'y'), '2-y');
  // First call: keyFn (miss path). Second call to memo(1,'x') only re-runs keyFn.
  assert.equal(await memo(1, 'x'), '1-x');

  assert.deepEqual(seen, [
    [1, 'x'],
    [2, 'y'],
    [1, 'x'],
  ]);
});

void test('memoize: separate cache instances have independent dedup tables', async () => {
  caches.clear();
  const cacheA = new LRUCacheForClustersAsPromised<string, number>({ namespace: 'memo-7a', max: 10 });
  const cacheB = new LRUCacheForClustersAsPromised<string, number>({ namespace: 'memo-7b', max: 10 });

  let callsA = 0;
  let callsB = 0;
  const memoA = memoize(
    cacheA,
    async (n: number) => {
      callsA += 1;
      await new Promise((r) => setTimeout(r, 5));
      return n;
    },
    (n) => `n:${n}`,
  );
  const memoB = memoize(
    cacheB,
    async (n: number) => {
      callsB += 1;
      await new Promise((r) => setTimeout(r, 5));
      return n * -1;
    },
    (n) => `n:${n}`,
  );

  const [a, b] = await Promise.all([memoA(7), memoB(7)]);
  assert.equal(a, 7);
  assert.equal(b, -7);
  assert.equal(callsA, 1);
  assert.equal(callsB, 1);
});
