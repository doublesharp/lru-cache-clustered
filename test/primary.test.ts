import test from 'node:test';
import assert from 'node:assert/strict';
import { getOrCreateCache, caches, handleRequest } from '../src/primary.ts';
import { SOURCE, type Request } from '../src/messages.ts';

test('getOrCreateCache creates a cache for a new namespace', () => {
  caches.clear();
  const cache = getOrCreateCache('alpha', { max: 5 });
  assert.equal(cache.max, 5);
  assert.ok(caches.has('alpha'));
});

test('getOrCreateCache returns existing cache for known namespace', () => {
  caches.clear();
  const a = getOrCreateCache('beta', { max: 3 });
  const b = getOrCreateCache('beta', { max: 99 });
  assert.equal(a, b);
  assert.equal(a.max, 3);
});

function req<T extends { op: string }>(extra: T) {
  return { id: 'req-1', namespace: 'ns-init', source: SOURCE, ...extra };
}

test('handleRequest op=init creates cache and returns ok', () => {
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

test('handleRequest op=init reuses cache and returns isNew=false', () => {
  caches.clear();
  handleRequest(req({ op: 'init', options: { max: 7 } }));
  const r = handleRequest(req({ op: 'init', options: { max: 99 } }));
  assert.equal(r.ok, true);
  assert.deepEqual((r as { value: unknown }).value, {
    namespace: 'ns-init',
    isNew: false,
    max: 7,
  });
});

test('handleRequest CRUD ops', () => {
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

test('handleRequest multi ops', () => {
  caches.clear();
  const ns = 'multi';
  const dispatch = (op: string, extra: object = {}) =>
    handleRequest({ id: 'r', namespace: ns, source: SOURCE, op, ...extra } as Request);

  dispatch('init', { options: { max: 100 } });
  dispatch('mSet', { entries: [['a', 1], ['b', 2], ['c', 3]] });
  const got = (dispatch('mGet', { keys: ['a', 'b', 'missing'] }) as { value: unknown }).value;
  assert.deepEqual(got, [['a', 1], ['b', 2], ['missing', undefined]]);

  dispatch('mDelete', { keys: ['a', 'c'] });
  const after = (dispatch('mGet', { keys: ['a', 'b', 'c'] }) as { value: unknown }).value;
  assert.deepEqual(after, [['a', undefined], ['b', 2], ['c', undefined]]);
});

test('handleRequest enumeration ops', () => {
  caches.clear();
  const ns = 'enum';
  const d = (op: string, extra: object = {}) =>
    handleRequest({ id: 'r', namespace: ns, source: SOURCE, op, ...extra } as Request);

  d('init', { options: { max: 10 } });
  d('mSet', { entries: [['a', 1], ['b', 2]] });

  assert.deepEqual((d('keys') as { value: unknown }).value, ['b', 'a']); // most recent first
  assert.deepEqual((d('values') as { value: unknown }).value, [2, 1]);
  assert.deepEqual((d('entries') as { value: unknown }).value, [['b', 2], ['a', 1]]);
  assert.equal((d('size') as { value: unknown }).value, 2);

  const dump = (d('dump') as { value: unknown }).value;
  assert.ok(Array.isArray(dump));
  assert.equal((dump as unknown[]).length, 2);

  // purgeStale on non-stale entries returns false (no entries were purged)
  assert.equal(typeof (d('purgeStale') as { value: unknown }).value, 'boolean');
});

test('handleRequest incr/decr', () => {
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

test('handleRequest config getters and setters', () => {
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

test('handleRequest returns error for unknown op', () => {
  const r = handleRequest({ id: 'r', namespace: 'x', source: SOURCE, op: 'bogus' } as unknown as Request);
  assert.equal(r.ok, false);
  assert.match((r as { error: string }).error, /unhandled op/);
});
