import test from 'node:test';
import assert from 'node:assert/strict';
import { getOrCreateCache, caches, handleRequest, stats } from '../src/primary.ts';
import { SOURCE, deserializeError, serializeError, type Request, type Stats } from '../src/messages.ts';

void test('getOrCreateCache creates a cache for a new namespace', () => {
  caches.clear();
  const cache = getOrCreateCache('alpha', { max: 5 });
  assert.equal(cache.max, 5);
  assert.ok(caches.has('alpha'));
});

void test('getOrCreateCache returns existing cache for known namespace', () => {
  caches.clear();
  const a = getOrCreateCache('beta', { max: 3 });
  const b = getOrCreateCache('beta', { max: 3 });
  assert.equal(a, b);
  assert.equal(a.max, 3);
});

function req<T extends { op: string }>(extra: T) {
  return { id: 'req-1', namespace: 'ns-init', source: SOURCE, ...extra };
}

void test('handleRequest op=init creates cache and returns ok', () => {
  caches.clear();
  const r = handleRequest(req({ op: 'init', options: { max: 7 } }));
  assert.equal(r.ok, true);
  assert.deepEqual(r, {
    id: 'req-1',
    source: SOURCE,
    ok: true,
    value: { namespace: 'ns-init', isNew: true, max: 7 },
  });
  assert.ok(caches.has('ns-init'));
});

void test('handleRequest op=init reuses cache and returns isNew=false', () => {
  caches.clear();
  handleRequest(req({ op: 'init', options: { max: 7 } }));
  const r = handleRequest(req({ op: 'init', options: { max: 7 } }));
  assert.equal(r.ok, true);
  assert.deepEqual((r as { value: unknown }).value, {
    namespace: 'ns-init',
    isNew: false,
    max: 7,
  });
});

void test('handleRequest op=init rejects conflicting options for an existing namespace', () => {
  caches.clear();
  stats.clear();
  const first = handleRequest(req({ op: 'init', options: { max: 7, ttl: 1000 } }));
  assert.equal(first.ok, true);

  const second = handleRequest(req({ op: 'init', options: { max: 8 } }));
  assert.equal(second.ok, false);
  assert.match((second as { error: { message: string } }).error.message, /Conflicting options/);
});

void test('handleRequest op=init ignores explicitly undefined options on reuse', () => {
  caches.clear();
  stats.clear();
  const first = handleRequest(req({ op: 'init', options: { max: 7, ttl: 1000 } }));
  assert.equal(first.ok, true);

  const second = handleRequest(req({ op: 'init', options: { max: 7, ttl: undefined } }));
  assert.equal(second.ok, true);
  assert.deepEqual((second as { value: unknown }).value, {
    namespace: 'ns-init',
    isNew: false,
    max: 7,
  });
});

void test('handleRequest CRUD ops', () => {
  caches.clear();
  const ns = 'crud';
  const init = (op: string, extra: object = {}) =>
    handleRequest({ id: 'r', namespace: ns, source: SOURCE, op, ...extra } as Request);

  init('init', { options: { max: 10 } });

  assert.equal((init('set', { key: 'k', value: 'v' }) as { value: unknown }).value, true);
  assert.equal((init('get', { key: 'k' }) as { value: unknown }).value, 'v');
  assert.equal((init('has', { key: 'k' }) as { value: unknown }).value, true);
  assert.equal((init('peek', { key: 'k' }) as { value: unknown }).value, 'v');
  assert.equal((init('delete', { key: 'k' }) as { value: unknown }).value, true);
  assert.equal((init('get', { key: 'k' }) as { value: unknown }).value, undefined);

  init('set', { key: 'a', value: 1 });
  init('set', { key: 'b', value: 2 });
  assert.equal((init('clear') as { value: unknown }).value, undefined);
  assert.equal((init('get', { key: 'a' }) as { value: unknown }).value, undefined);
});

void test('handleRequest multi ops', () => {
  caches.clear();
  const ns = 'multi';
  const dispatch = (op: string, extra: object = {}) =>
    handleRequest({ id: 'r', namespace: ns, source: SOURCE, op, ...extra } as Request);

  dispatch('init', { options: { max: 100 } });
  dispatch('mSet', {
    entries: [
      ['a', 1],
      ['b', 2],
      ['c', 3],
    ],
  });
  const got = (dispatch('mGet', { keys: ['a', 'b', 'missing'] }) as { value: unknown }).value;
  assert.deepEqual(got, [
    ['a', 1],
    ['b', 2],
    ['missing', undefined],
  ]);

  dispatch('mDelete', { keys: ['a', 'c'] });
  const after = (dispatch('mGet', { keys: ['a', 'b', 'c'] }) as { value: unknown }).value;
  assert.deepEqual(after, [
    ['a', undefined],
    ['b', 2],
    ['c', undefined],
  ]);
});

void test('handleRequest enumeration ops', () => {
  caches.clear();
  const ns = 'enum';
  const d = (op: string, extra: object = {}) =>
    handleRequest({ id: 'r', namespace: ns, source: SOURCE, op, ...extra } as Request);

  d('init', { options: { max: 10 } });
  d('mSet', {
    entries: [
      ['a', 1],
      ['b', 2],
    ],
  });

  assert.deepEqual((d('keys') as { value: unknown }).value, ['b', 'a']); // most recent first
  assert.deepEqual((d('values') as { value: unknown }).value, [2, 1]);
  assert.deepEqual((d('entries') as { value: unknown }).value, [
    ['b', 2],
    ['a', 1],
  ]);
  assert.equal((d('size') as { value: unknown }).value, 2);

  const dump = (d('dump') as { value: unknown }).value;
  assert.ok(Array.isArray(dump));
  assert.equal((dump as unknown[]).length, 2);

  // purgeStale on non-stale entries returns false (no entries were purged)
  assert.equal(typeof (d('purgeStale') as { value: unknown }).value, 'boolean');
});

void test('handleRequest incr/decr', () => {
  caches.clear();
  const ns = 'counter';
  const d = (op: string, extra: object = {}) =>
    handleRequest({ id: 'r', namespace: ns, source: SOURCE, op, ...extra } as Request);

  d('init', { options: { max: 10 } });

  assert.equal((d('incr', { key: 'c' }) as { value: unknown }).value, 1);
  assert.equal((d('incr', { key: 'c' }) as { value: unknown }).value, 2);
  assert.equal((d('incr', { key: 'c', amount: 5 }) as { value: unknown }).value, 7);
  assert.equal((d('decr', { key: 'c' }) as { value: unknown }).value, 6);
  assert.equal((d('decr', { key: 'c', amount: 10 }) as { value: unknown }).value, -4);
});

void test('handleRequest config getters and setters', () => {
  caches.clear();
  const ns = 'cfg';
  const d = (op: string, extra: object = {}) =>
    handleRequest({ id: 'r', namespace: ns, source: SOURCE, op, ...extra } as Request);

  d('init', { options: { max: 10, ttl: 1000 } });
  assert.equal((d('max') as { value: unknown }).value, 10);
  assert.equal((d('max', { value: 50 }) as { value: unknown }).value, 50);
  assert.equal((d('ttl') as { value: unknown }).value, 1000);
  assert.equal((d('ttl', { value: 5000 }) as { value: unknown }).value, 5000);
  assert.equal((d('allowStale') as { value: unknown }).value, false);
  assert.equal((d('allowStale', { value: true }) as { value: unknown }).value, true);
});

void test('handleRequest rejects nullish keys and values', () => {
  caches.clear();
  stats.clear();
  const ns = 'nullish-dispatch';
  const d = (op: string, extra: object = {}) =>
    handleRequest({ id: 'r', namespace: ns, source: SOURCE, op, ...extra } as Request);

  assert.equal(d('set', { key: undefined, value: 'v' }).ok, false);
  assert.equal(d('set', { key: 'k', value: undefined }).ok, false);
  assert.equal(d('get', { key: null }).ok, false);
});

void test('handleRequest returns error for unknown op', () => {
  const r = handleRequest({ id: 'r', namespace: 'x', source: SOURCE, op: 'bogus' } as unknown as Request);
  assert.equal(r.ok, false);
  assert.match((r as { error: { message: string } }).error.message, /unhandled op/);
});

void test('handleRequest catches handler exceptions and returns ok=false', () => {
  caches.clear();
  // Pre-create a cache and break one of its methods to force a throw inside the switch.
  handleRequest({ id: 'i', namespace: 'boom', source: SOURCE, op: 'init', options: { max: 5 } });
  const cache = caches.get('boom');
  assert.ok(cache);
  (cache as { get: (k: unknown) => unknown }).get = () => {
    throw new Error('boom-message');
  };
  const r = handleRequest({ id: 'r', namespace: 'boom', source: SOURCE, op: 'get', key: 'x' });
  assert.equal(r.ok, false);
  assert.match((r as { error: { message: string } }).error.message, /boom-message/);
});

void test('handleRequest max setter rebuilds the cache, preserving entries', () => {
  caches.clear();
  const ns = 'rebuild';
  const d = (op: string, extra: object = {}) =>
    handleRequest({ id: 'r', namespace: ns, source: SOURCE, op, ...extra } as Request);

  d('init', { options: { max: 10, ttl: 1000, allowStale: true } });
  d('set', { key: 'a', value: 1 });
  d('set', { key: 'b', value: 2 });

  // Change max — primary rebuilds the underlying cache while preserving entries.
  assert.equal((d('max', { value: 50 }) as { value: unknown }).value, 50);
  assert.equal((d('get', { key: 'a' }) as { value: unknown }).value, 1);
  assert.equal((d('get', { key: 'b' }) as { value: unknown }).value, 2);
  // Tunables preserved.
  assert.equal((d('ttl') as { value: unknown }).value, 1000);
  assert.equal((d('allowStale') as { value: unknown }).value, true);
});

void test('handleRequest max setter preserves per-entry remaining TTL', async () => {
  caches.clear();
  stats.clear();
  const ns = 'rebuild-ttl';
  const d = (op: string, extra: object = {}) =>
    handleRequest({ id: 'r', namespace: ns, source: SOURCE, op, ...extra } as Request);

  d('init', { options: { max: 10 } });
  d('set', { key: 'k', value: 'v', ttl: 50 });
  await new Promise((r) => setTimeout(r, 20));
  const before = (d('getRemainingTTL', { key: 'k' }) as { value: number }).value;

  d('max', { value: 20 });
  const after = (d('getRemainingTTL', { key: 'k' }) as { value: number }).value;

  assert.ok(before > 0);
  assert.ok(after > 0, `expected positive ttl after rebuild, got ${after}`);
  assert.ok(after <= before, `expected ttl to keep ticking down (${after} <= ${before})`);
});

void test('handleRequest max setter preserves all SerializableLruOptions', () => {
  caches.clear();
  const ns = 'rebuild-tunables';
  const d = (op: string, extra: object = {}) =>
    handleRequest({ id: 'r', namespace: ns, source: SOURCE, op, ...extra } as Request);

  d('init', {
    options: {
      max: 10,
      ttl: 1000,
      allowStale: true,
      updateAgeOnGet: true,
      updateAgeOnHas: true,
      noDeleteOnStaleGet: true,
      ttlAutopurge: true,
    },
  });
  d('set', { key: 'a', value: 1 });
  d('max', { value: 50 });

  // All fields should survive the rebuild — read straight off the underlying cache.
  const cache = caches.get(ns) as unknown as {
    max: number;
    ttl: number;
    allowStale: boolean;
    updateAgeOnGet: boolean;
    updateAgeOnHas: boolean;
    noDeleteOnStaleGet: boolean;
    ttlAutopurge: boolean;
  };
  assert.equal(cache.max, 50);
  assert.equal(cache.ttl, 1000);
  assert.equal(cache.allowStale, true);
  assert.equal(cache.updateAgeOnGet, true);
  assert.equal(cache.updateAgeOnHas, true);
  assert.equal(cache.noDeleteOnStaleGet, true);
  assert.equal(cache.ttlAutopurge, true);
});

void test('handleRequest max setter preserves LRU order (MRU stays MRU)', () => {
  caches.clear();
  const ns = 'rebuild-order';
  const d = (op: string, extra: object = {}) =>
    handleRequest({ id: 'r', namespace: ns, source: SOURCE, op, ...extra } as Request);

  d('init', { options: { max: 10 } });
  // Insertion order: 'lru' first → 'mru' last. After this, 'mru' is most recent.
  d('set', { key: 'lru', value: 1 });
  d('set', { key: 'mru', value: 2 });

  // Shrink to size 1 — under correct LRU semantics, 'lru' (least recent) is
  // evicted and 'mru' survives. The pre-fix bug reversed this.
  d('max', { value: 1 });
  const survivor = (d('keys') as { value: unknown[] }).value;
  assert.deepEqual(survivor, ['mru']);
  assert.equal((d('get', { key: 'mru' }) as { value: unknown }).value, 2);
  assert.equal((d('get', { key: 'lru' }) as { value: unknown }).value, undefined);
});

void test('handleRequest op=getRemainingTTL returns a positive ttl when set', () => {
  caches.clear();
  stats.clear();
  const ns = 'rttl';
  const d = (op: string, extra: object = {}) =>
    handleRequest({ id: 'r', namespace: ns, source: SOURCE, op, ...extra } as Request);

  d('init', { options: { max: 10 } });
  d('set', { key: 'k', value: 'v', ttl: 60_000 });
  const remaining = (d('getRemainingTTL', { key: 'k' }) as { value: unknown }).value;
  assert.equal(typeof remaining, 'number');
  assert.ok((remaining as number) > 0 && (remaining as number) <= 60_000);

  // Missing keys: lru-cache returns 0 (or Infinity if no ttl is set on the cache).
  const missing = (d('getRemainingTTL', { key: 'nope' }) as { value: unknown }).value;
  assert.equal(typeof missing, 'number');
});

void test('handleRequest op=setIfAbsent sets when key absent, no-op when present', () => {
  caches.clear();
  stats.clear();
  const ns = 'sia';
  const d = (op: string, extra: object = {}) =>
    handleRequest({ id: 'r', namespace: ns, source: SOURCE, op, ...extra } as Request);

  d('init', { options: { max: 10 } });

  assert.equal((d('setIfAbsent', { key: 'k', value: 'first' }) as { value: unknown }).value, true);
  assert.equal((d('get', { key: 'k' }) as { value: unknown }).value, 'first');

  // Second call should NOT overwrite and should return false.
  assert.equal((d('setIfAbsent', { key: 'k', value: 'second' }) as { value: unknown }).value, false);
  assert.equal((d('get', { key: 'k' }) as { value: unknown }).value, 'first');
});

void test('handleRequest op=setIfAbsent honors optional ttl', () => {
  caches.clear();
  stats.clear();
  const ns = 'sia-ttl';
  const d = (op: string, extra: object = {}) =>
    handleRequest({ id: 'r', namespace: ns, source: SOURCE, op, ...extra } as Request);

  d('init', { options: { max: 10 } });
  assert.equal((d('setIfAbsent', { key: 'k', value: 'v', ttl: 30_000 }) as { value: unknown }).value, true);
  const remaining = (d('getRemainingTTL', { key: 'k' }) as { value: unknown }).value;
  assert.equal(typeof remaining, 'number');
  assert.ok((remaining as number) > 0 && (remaining as number) <= 30_000);
});

void test('handleRequest op=load restores entries from a dump', () => {
  caches.clear();
  stats.clear();
  const srcNs = 'load-src';
  const dstNs = 'load-dst';
  const dispatch = (ns: string, op: string, extra: object = {}) =>
    handleRequest({ id: 'r', namespace: ns, source: SOURCE, op, ...extra } as Request);

  dispatch(srcNs, 'init', { options: { max: 10 } });
  dispatch(srcNs, 'mSet', {
    entries: [
      ['a', 1],
      ['b', 2],
    ],
  });
  const dump = (dispatch(srcNs, 'dump') as { value: unknown }).value as Array<[unknown, unknown]>;
  assert.ok(Array.isArray(dump));

  dispatch(dstNs, 'init', { options: { max: 10 } });
  const r = dispatch(dstNs, 'load', { entries: dump });
  assert.equal(r.ok, true);
  assert.equal((r as { value: unknown }).value, undefined);

  assert.equal((dispatch(dstNs, 'get', { key: 'a' }) as { value: unknown }).value, 1);
  assert.equal((dispatch(dstNs, 'get', { key: 'b' }) as { value: unknown }).value, 2);
});

void test('handleRequest op=incr with ttl sets ttl only on first write', async () => {
  caches.clear();
  stats.clear();
  const ns = 'incr-ttl';
  const d = (op: string, extra: object = {}) =>
    handleRequest({ id: 'r', namespace: ns, source: SOURCE, op, ...extra } as Request);

  d('init', { options: { max: 10 } });

  // First incr creates the key with ttl=60_000.
  assert.equal((d('incr', { key: 'rl', ttl: 60_000 }) as { value: unknown }).value, 1);
  const firstRemaining = (d('getRemainingTTL', { key: 'rl' }) as { value: unknown }).value as number;
  assert.ok(firstRemaining > 0 && firstRemaining <= 60_000);

  // Wait a brief moment so the remaining TTL would visibly decrease if reset.
  await new Promise((resolve) => setTimeout(resolve, 25));

  // Second incr WITHOUT ttl must NOT reset the TTL — the existing entry's
  // expiration should continue ticking down.
  assert.equal((d('incr', { key: 'rl' }) as { value: unknown }).value, 2);
  const secondRemaining = (d('getRemainingTTL', { key: 'rl' }) as { value: unknown }).value as number;
  assert.ok(secondRemaining > 0);
  assert.ok(secondRemaining <= firstRemaining, `expected ${secondRemaining} <= ${firstRemaining}`);

  // Third incr WITH a fresh ttl should also NOT reset (key already existed).
  assert.equal((d('incr', { key: 'rl', ttl: 60_000 }) as { value: unknown }).value, 3);
  const thirdRemaining = (d('getRemainingTTL', { key: 'rl' }) as { value: unknown }).value as number;
  assert.ok(thirdRemaining <= firstRemaining, `expected ${thirdRemaining} <= ${firstRemaining}`);
});

void test('handleRequest op=decr with ttl sets ttl only on first write', () => {
  caches.clear();
  stats.clear();
  const ns = 'decr-ttl';
  const d = (op: string, extra: object = {}) =>
    handleRequest({ id: 'r', namespace: ns, source: SOURCE, op, ...extra } as Request);

  d('init', { options: { max: 10 } });
  assert.equal((d('decr', { key: 'd', ttl: 45_000 }) as { value: unknown }).value, -1);
  const remaining = (d('getRemainingTTL', { key: 'd' }) as { value: unknown }).value as number;
  assert.ok(remaining > 0 && remaining <= 45_000);
});

void test('handleRequest op=stats returns counters after get/set/delete', () => {
  caches.clear();
  stats.clear();
  const ns = 'stats-basic';
  const d = (op: string, extra: object = {}) =>
    handleRequest({ id: 'r', namespace: ns, source: SOURCE, op, ...extra } as Request);

  d('init', { options: { max: 10 } });
  d('set', { key: 'a', value: 1 });
  d('set', { key: 'b', value: 2 });
  d('get', { key: 'a' });
  d('get', { key: 'a' });
  d('get', { key: 'missing' });
  d('delete', { key: 'a' });
  d('delete', { key: 'still-missing' }); // not counted; returned false

  const s = (d('stats') as { value: unknown }).value as Stats;
  assert.equal(s.namespace, ns);
  assert.equal(s.sets, 2);
  assert.equal(s.hits, 2);
  assert.equal(s.misses, 1);
  assert.equal(s.deletes, 1);
  assert.equal(s.evictions, 0);
  assert.equal(s.size, 1);
});

void test('handleRequest op=stats returns a fresh object, not the live ref', () => {
  caches.clear();
  stats.clear();
  const ns = 'stats-snapshot';
  const d = (op: string, extra: object = {}) =>
    handleRequest({ id: 'r', namespace: ns, source: SOURCE, op, ...extra } as Request);

  d('init', { options: { max: 10 } });
  d('set', { key: 'a', value: 1 });

  const snapshot = (d('stats') as { value: unknown }).value as Stats;
  assert.equal(snapshot.sets, 1);

  // Mutating the snapshot must not affect future reads.
  snapshot.sets = 9999;
  const fresh = (d('stats') as { value: unknown }).value as Stats;
  assert.equal(fresh.sets, 1);
});

void test('handleRequest stats counts evictions when capacity is exceeded', () => {
  caches.clear();
  stats.clear();
  const ns = 'evict';
  const d = (op: string, extra: object = {}) =>
    handleRequest({ id: 'r', namespace: ns, source: SOURCE, op, ...extra } as Request);

  d('init', { options: { max: 2 } });
  d('set', { key: 'a', value: 1 });
  d('set', { key: 'b', value: 2 });
  d('set', { key: 'c', value: 3 }); // forces eviction of 'a'

  const s = (d('stats') as { value: unknown }).value as Stats;
  assert.equal(s.evictions, 1);
  assert.equal(s.sets, 3);
  assert.equal(s.size, 2);
});

void test('handleRequest clear does not increment deletes', () => {
  caches.clear();
  stats.clear();
  const ns = 'clear-stats';
  const d = (op: string, extra: object = {}) =>
    handleRequest({ id: 'r', namespace: ns, source: SOURCE, op, ...extra } as Request);

  d('init', { options: { max: 10 } });
  d('mSet', {
    entries: [
      ['a', 1],
      ['b', 2],
    ],
  });
  d('clear');
  const s = (d('stats') as { value: unknown }).value as Stats;
  assert.equal(s.deletes, 0);
  assert.equal(s.sets, 2);
  assert.equal(s.size, 0);
});

void test('handleRequest mDelete only counts keys actually deleted', () => {
  caches.clear();
  stats.clear();
  const ns = 'mdelete-stats';
  const d = (op: string, extra: object = {}) =>
    handleRequest({ id: 'r', namespace: ns, source: SOURCE, op, ...extra } as Request);

  d('init', { options: { max: 10 } });
  d('set', { key: 'a', value: 1 });
  d('mDelete', { keys: ['a', 'missing-1', 'missing-2'] });
  const s = (d('stats') as { value: unknown }).value as Stats;
  assert.equal(s.deletes, 1);
});

void test('handleRequest setIfAbsent only counts sets when actually set', () => {
  caches.clear();
  stats.clear();
  const ns = 'sia-stats';
  const d = (op: string, extra: object = {}) =>
    handleRequest({ id: 'r', namespace: ns, source: SOURCE, op, ...extra } as Request);

  d('init', { options: { max: 10 } });
  d('setIfAbsent', { key: 'k', value: 'v' }); // sets++
  d('setIfAbsent', { key: 'k', value: 'v2' }); // no-op
  d('setIfAbsent', { key: 'k', value: 'v3' }); // no-op
  const s = (d('stats') as { value: unknown }).value as Stats;
  assert.equal(s.sets, 1);
});

void test('handleRequest incr/decr count as sets in stats', () => {
  caches.clear();
  stats.clear();
  const ns = 'incr-stats';
  const d = (op: string, extra: object = {}) =>
    handleRequest({ id: 'r', namespace: ns, source: SOURCE, op, ...extra } as Request);

  d('init', { options: { max: 10 } });
  d('incr', { key: 'c' });
  d('incr', { key: 'c' });
  d('decr', { key: 'c' });
  const s = (d('stats') as { value: unknown }).value as Stats;
  assert.equal(s.sets, 3);
});

void test('handleRequest rejects non-object input with empty id and structured error', () => {
  const r1 = handleRequest('not an object' as unknown as Request);
  assert.equal(r1.ok, false);
  assert.equal(r1.id, '');
  assert.match((r1 as { error: { message: string } }).error.message, /not an object/);

  const r2 = handleRequest(null as unknown as Request);
  assert.equal(r2.ok, false);
  assert.equal(r2.id, '');
});

void test('getStats recreates the stats record if it has been removed', () => {
  caches.clear();
  stats.clear();
  // Init creates both the cache and its stats record.
  handleRequest({ id: 'i', namespace: 'gs', source: SOURCE, op: 'init', options: { max: 5 } });
  // Externally remove the stats record while the cache stays around.
  stats.delete('gs');
  // A subsequent op (set) calls getStats, which should recreate the record.
  const r = handleRequest({ id: 's', namespace: 'gs', source: SOURCE, op: 'set', key: 'k', value: 'v' });
  assert.equal(r.ok, true);
  const recreated = stats.get('gs');
  assert.ok(recreated);
  assert.equal(recreated.namespace, 'gs');
  assert.equal(recreated.sets, 1);
});

void test('serializeError captures Error code and chained cause', () => {
  const inner = new Error('inner-msg');
  (inner as { code?: string }).code = 'E_INNER';
  const outer = new Error('outer-msg');
  (outer as { code?: string }).code = 'E_OUTER';
  (outer as { cause?: unknown }).cause = inner;
  const s = serializeError(outer);
  assert.equal(s.name, 'Error');
  assert.equal(s.message, 'outer-msg');
  assert.equal(s.code, 'E_OUTER');
  assert.ok(s.cause);
  assert.equal(s.cause.message, 'inner-msg');
  assert.equal(s.cause.code, 'E_INNER');
});

void test('serializeError accepts numeric code', () => {
  const e = new Error('numeric');
  (e as { code?: number }).code = 42;
  assert.equal(serializeError(e).code, 42);
});

void test('serializeError handles Error without stack', () => {
  const e = new Error('no-stack');
  (e as { stack?: undefined }).stack = undefined;
  const s = serializeError(e);
  assert.equal(s.message, 'no-stack');
  assert.equal(s.stack, undefined);
});

void test('serializeError wraps non-Error throws', () => {
  assert.deepEqual(serializeError('plain string'), { name: 'Error', message: 'plain string' });
  assert.deepEqual(serializeError(42), { name: 'Error', message: '42' });
  assert.deepEqual(serializeError({ foo: 1 }), { name: 'Error', message: '[object Object]' });
});

void test('deserializeError round-trips through serialize', () => {
  const original = new Error('round-trip');
  original.name = 'CustomErr';
  (original as { code?: string }).code = 'E_RT';
  (original as { cause?: unknown }).cause = new Error('the-cause');
  const reconstructed = deserializeError(serializeError(original));
  assert.equal(reconstructed.name, 'CustomErr');
  assert.equal(reconstructed.message, 'round-trip');
  assert.equal((reconstructed as { code?: unknown }).code, 'E_RT');
  const cause = (reconstructed as { cause?: Error }).cause;
  assert.ok(cause instanceof Error);
  assert.equal(cause.message, 'the-cause');
});
