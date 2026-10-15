import assert from 'node:assert/strict';
import { LRUCache } from 'lru-cache';

// Another installed package copy may have created this registry before the
// process-wide mutation counter was introduced. Set it up before importing.
const namespace = 'primary-coverage-legacy';
const existing = new LRUCache<string, string>({ max: 10 });
existing.set('retained', 'old package value');
const legacyState = {
  caches: new Map([[namespace, existing]]),
  stats: new Map(),
  fetchLocks: new Map(),
  versions: new Map(),
  clusterListenerInstalled: false,
  nextFetchToken: 0,
};
(globalThis as Record<PropertyKey, unknown>)[Symbol.for('lru-cache-clustered.primary')] = legacyState;

const primary = await import('../../src/primary.ts');
assert.equal(primary.caches, legacyState.caches);
assert.equal(primary.caches.get(namespace), existing);
assert.equal(primary.dispatchOp(namespace, { op: 'get', key: 'retained' }), 'old package value');
const first = primary.dispatchAndBroadcast(namespace, { op: 'set', key: 'first', value: 'new package value' });
assert.deepEqual(first, { value: true, version: 1 });
assert.equal(existing.get('first'), 'new package value');
const second = primary.dispatchAndBroadcast(namespace, { op: 'set', key: 'second', value: 'next' });
assert.equal(second.version, 2);
const destroyed = primary.dispatchAndBroadcast(namespace, { op: 'destroy' });
assert.equal(destroyed.value, true);
assert.equal(destroyed.version, 3);
assert.equal(legacyState.caches.has(namespace), false);
assert.equal(legacyState.versions.has(namespace), false);
console.log('legacy primary state retained; mutation versions 1, 2, 3');
