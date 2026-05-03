import test from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync, gunzipSync } from 'node:zlib';
import { LRUCacheForClustersAsPromised } from '../src/index.ts';
import { wrap, type Codec } from '../src/codec.ts';
import { caches } from '../src/primary.ts';

/* eslint-disable @typescript-eslint/no-empty-object-type */
// JSON+gzip codec, exercises the realistic compression use case.
// V is typed as `{}` (non-nullish) to match the lru-cache@11 generic
// constraint the public class now mirrors.
const gzipJsonCodec: Codec<{}, Buffer> = {
  encode: (value: {}) => gzipSync(Buffer.from(JSON.stringify(value), 'utf8')),
  decode: (raw: Buffer) => JSON.parse(gunzipSync(raw).toString('utf8')) as {},
};
/* eslint-enable @typescript-eslint/no-empty-object-type */

// Identity codec — proves that wrap() is value-preserving when the codec is.
const identityCodec: Codec<string, string> = {
  encode: (v) => v,
  decode: (v) => v,
};

void test('wrap: get/set round-trips through gzip codec', async () => {
  caches.clear();
  const inner = new LRUCacheForClustersAsPromised<string, Buffer>({ namespace: 'codec-rt', max: 10 });
  const c = wrap(inner, gzipJsonCodec);
  await c.set('user', { id: 42, name: 'ada' });
  const got = (await c.get('user')) as { id: number; name: string } | undefined;
  assert.deepEqual(got, { id: 42, name: 'ada' });
  // The underlying cache holds the encoded Buffer, not the plain object.
  const raw = await inner.get('user');
  assert.ok(Buffer.isBuffer(raw), 'underlying value should be a Buffer');
});

void test('wrap: get returns undefined for missing keys without invoking decode', async () => {
  caches.clear();
  let decodeCalls = 0;
  const codec: Codec<string, string> = {
    encode: (v) => v,
    decode: (v) => {
      decodeCalls++;
      return v;
    },
  };
  const inner = new LRUCacheForClustersAsPromised<string, string>({ namespace: 'codec-miss', max: 10 });
  const c = wrap(inner, codec);
  assert.equal(await c.get('nope'), undefined);
  assert.equal(decodeCalls, 0);
});

void test('wrap: setIfAbsent encodes and respects existing entry', async () => {
  caches.clear();
  const inner = new LRUCacheForClustersAsPromised<string, Buffer>({ namespace: 'codec-sia', max: 10 });
  const c = wrap(inner, gzipJsonCodec);
  assert.equal(await c.setIfAbsent('k', { v: 1 }), true);
  assert.equal(await c.setIfAbsent('k', { v: 2 }), false);
  assert.deepEqual(await c.get('k'), { v: 1 });
});

void test('wrap: peek returns undefined for missing keys', async () => {
  caches.clear();
  const inner = new LRUCacheForClustersAsPromised<string, string>({ namespace: 'codec-peek-miss', max: 10 });
  const c = wrap(inner, identityCodec);
  assert.equal(await c.peek('nope'), undefined);
});

void test('wrap: peek decodes without promoting LRU position', async () => {
  caches.clear();
  const inner = new LRUCacheForClustersAsPromised<string, Buffer>({ namespace: 'codec-peek', max: 3 });
  const c = wrap(inner, gzipJsonCodec);
  await c.set('a', 'A');
  await c.set('b', 'B');
  await c.set('c', 'C');
  assert.equal(await c.peek('a'), 'A');
  // After peek, 'a' is still LRU — adding 'd' must evict it.
  await c.set('d', 'D');
  assert.equal(await c.get('a'), undefined);
});

void test('wrap: mGet/mSet round-trip through codec', async () => {
  caches.clear();
  const inner = new LRUCacheForClustersAsPromised<string, Buffer>({ namespace: 'codec-multi', max: 10 });
  const c = wrap(inner, gzipJsonCodec);
  await c.mSet([
    ['a', { n: 1 }],
    ['b', { n: 2 }],
  ]);
  const got = await c.mGet(['a', 'b', 'missing']);
  assert.deepEqual(
    [...got.entries()],
    [
      ['a', { n: 1 }],
      ['b', { n: 2 }],
      ['missing', undefined],
    ],
  );
});

void test('wrap: keys/values/entries decode appropriately', async () => {
  caches.clear();
  const inner = new LRUCacheForClustersAsPromised<string, Buffer>({ namespace: 'codec-enum', max: 10 });
  const c = wrap(inner, gzipJsonCodec);
  await c.set('x', { v: 'X' });
  await c.set('y', { v: 'Y' });
  assert.deepEqual(await c.keys(), ['y', 'x']);
  assert.deepEqual(await c.values(), [{ v: 'Y' }, { v: 'X' }]);
  assert.deepEqual(await c.entries(), [
    ['y', { v: 'Y' }],
    ['x', { v: 'X' }],
  ]);
});

void test('wrap: [Symbol.asyncIterator] yields decoded entries', async () => {
  caches.clear();
  const inner = new LRUCacheForClustersAsPromised<string, Buffer>({ namespace: 'codec-iter', max: 10 });
  const c = wrap(inner, gzipJsonCodec);
  await c.set('a', 1);
  await c.set('b', 2);
  const collected: Array<[string, unknown]> = [];
  for await (const pair of c) collected.push(pair);
  assert.equal(collected.length, 2);
  const map = new Map(collected);
  assert.equal(map.get('a'), 1);
  assert.equal(map.get('b'), 2);
});

void test('wrap: fetch dedups concurrent calls and decodes the cached value', async () => {
  caches.clear();
  const inner = new LRUCacheForClustersAsPromised<string, Buffer>({ namespace: 'codec-fetch', max: 10 });
  const c = wrap(inner, gzipJsonCodec);
  let calls = 0;
  const fetcher = async (key: string) => {
    calls++;
    await new Promise((r) => setTimeout(r, 5));
    return { key, computed: true };
  };
  const [a, b, d] = await Promise.all([c.fetch('k', fetcher), c.fetch('k', fetcher), c.fetch('k', fetcher)]);
  assert.equal(calls, 1);
  assert.deepEqual(a, { key: 'k', computed: true });
  assert.deepEqual(b, { key: 'k', computed: true });
  assert.deepEqual(d, { key: 'k', computed: true });
  // Subsequent call returns from cache without re-invoking fetcher.
  await c.fetch('k', fetcher);
  assert.equal(calls, 1);
});

void test('wrap: fetch with forceRefresh re-invokes fetcher', async () => {
  caches.clear();
  const inner = new LRUCacheForClustersAsPromised<string, string>({ namespace: 'codec-force', max: 10 });
  const c = wrap(inner, identityCodec);
  let calls = 0;
  const fetcher = () => {
    calls++;
    return `v${calls}`;
  };
  assert.equal(await c.fetch('k', fetcher), 'v1');
  assert.equal(await c.fetch('k', fetcher), 'v1'); // cached
  assert.equal(await c.fetch('k', fetcher, { forceRefresh: true }), 'v2');
});

void test('wrap: async codec works (Promise-returning encode/decode)', async () => {
  caches.clear();
  const codec: Codec<string, string> = {
    encode: async (v) => {
      await Promise.resolve();
      return `enc:${v}`;
    },
    decode: async (raw) => {
      await Promise.resolve();
      return raw.replace(/^enc:/, '');
    },
  };
  const inner = new LRUCacheForClustersAsPromised<string, string>({ namespace: 'codec-async', max: 10 });
  const c = wrap(inner, codec);
  await c.set('k', 'hello');
  assert.equal(await inner.get('k'), 'enc:hello');
  assert.equal(await c.get('k'), 'hello');
});

void test('wrap: passthrough methods (has/delete/clear/size/getRemainingTTL/purgeStale) work', async () => {
  caches.clear();
  const inner = new LRUCacheForClustersAsPromised<string, string>({ namespace: 'codec-pass', max: 10, ttl: 60_000 });
  const c = wrap(inner, identityCodec);
  await c.set('a', 'A');
  assert.equal(await c.has('a'), true);
  assert.equal(await c.has('missing'), false);
  const ttl = await c.getRemainingTTL('a');
  assert.ok(ttl > 0 && ttl <= 60_000);
  assert.equal(await c.size(), 1);
  assert.equal(await c.delete('a'), true);
  assert.equal(await c.has('a'), false);
  await c.set('b', 'B');
  await c.clear();
  assert.equal(await c.size(), 0);
  assert.equal(typeof (await c.purgeStale()), 'boolean');
});

void test('wrap: size-bounded caches and lifecycle passthroughs work', async () => {
  caches.clear();
  const inner = new LRUCacheForClustersAsPromised<string, string>({
    namespace: 'codec-size-pass',
    maxSize: 10,
    ttl: 1_000,
  });
  const c = wrap(inner, identityCodec);

  await assert.doesNotReject(c.healthCheck());
  await c.set('a', 'AA', { size: 2 });
  await c.mSet([['b', 'BBB', { size: 3 }]]);
  assert.equal(await c.get('a'), 'AA');
  assert.equal(await c.get('b'), 'BBB');
  assert.equal(await c.destroy(), true);
});

void test('wrap: stats reflect underlying cache activity', async () => {
  caches.clear();
  const inner = new LRUCacheForClustersAsPromised<string, string>({ namespace: 'codec-stats', max: 10 });
  const c = wrap(inner, identityCodec);
  const s0 = await c.stats();
  await c.set('k', 'v');
  await c.get('k');
  await c.get('miss');
  await c.delete('k');
  const s1 = await c.stats();
  assert.ok(s1.sets >= s0.sets + 1);
  assert.ok(s1.hits >= s0.hits + 1);
  assert.ok(s1.misses >= s0.misses + 1);
  assert.ok(s1.deletes >= s0.deletes + 1);
});

void test('wrap: encode errors propagate from set', async () => {
  caches.clear();
  const codec: Codec<string, string> = {
    encode: () => {
      throw new Error('encode failed');
    },
    decode: (v) => v,
  };
  const inner = new LRUCacheForClustersAsPromised<string, string>({ namespace: 'codec-enc-err', max: 10 });
  const c = wrap(inner, codec);
  await assert.rejects(c.set('k', 'v'), /encode failed/);
  assert.equal(await inner.size(), 0);
});

void test('wrap: decode errors propagate from get', async () => {
  caches.clear();
  const codec: Codec<string, string> = {
    encode: (v) => v,
    decode: () => {
      throw new Error('decode failed');
    },
  };
  const inner = new LRUCacheForClustersAsPromised<string, string>({ namespace: 'codec-dec-err', max: 10 });
  const c = wrap(inner, codec);
  await c.set('k', 'v');
  await assert.rejects(c.get('k'), /decode failed/);
});

void test('wrap: exposes underlying cache via .cache for escape hatches', async () => {
  caches.clear();
  const inner = new LRUCacheForClustersAsPromised<string, Buffer>({ namespace: 'codec-escape', max: 10 });
  const c = wrap(inner, gzipJsonCodec);
  assert.equal(c.cache.namespace, 'codec-escape');
  assert.equal(c.namespace, 'codec-escape');
  // Drop down to the underlying cache to access raw form.
  await c.set('k', { hello: 'world' });
  const dump = await inner.dump();
  assert.equal(dump.length, 1);
  // Round-trip through clear + load on the underlying form.
  await inner.clear();
  await inner.load(dump);
  assert.deepEqual(await c.get('k'), { hello: 'world' });
});
