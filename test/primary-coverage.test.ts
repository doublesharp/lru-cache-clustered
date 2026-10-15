import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import cluster, { type Worker } from 'node:cluster';
import test from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { LRUCacheClustered } from '../src/index.ts';
import { dispatchAndBroadcast, dispatchOp, getNamespaceVersion } from '../src/primary.ts';

const runFile = promisify(execFile);

void test('an asynchronous broadcast failure preserves the write without retrying', async () => {
  const namespace = 'primary-coverage-broadcast-error';
  const mutableCluster = cluster as unknown as { workers: Record<string, Worker> | undefined };
  const previousWorkers = mutableCluster.workers;
  const sent: unknown[] = [];
  const worker = {
    id: 9010,
    isConnected: () => true,
    send: (message: unknown, callback: (error: Error | null) => void) => {
      sent.push(message);
      globalThis.queueMicrotask(() => callback(Object.assign(new Error('write EPIPE'), { code: 'EPIPE' })));
      return false;
    },
  } as unknown as Worker;
  mutableCluster.workers = { '9010': worker };
  try {
    const result = dispatchAndBroadcast(namespace, { op: 'set', key: 'key', value: 'stored' });
    assert.equal(result.value, true);
    await setImmediate();
    assert.equal(dispatchOp(namespace, { op: 'get', key: 'key' }), 'stored');
    assert.equal((dispatchOp(namespace, { op: 'stats' }) as { sets: number }).sets, 1);
    assert.deepEqual(sent, [
      { source: 'lcfcap', push: 'l1:invalidate', namespace, key: 'key', version: result.version },
    ]);
  } finally {
    mutableCluster.workers = previousWorkers;
    dispatchAndBroadcast(namespace, { op: 'destroy' });
  }
});

void test('primary state from an older package copy acquires a mutation counter', async () => {
  const result = await runFile(
    process.execPath,
    ['--import', 'tsx', fileURLToPath(new URL('./fixtures/primary-compat-child.ts', import.meta.url))],
    { timeout: 10_000 },
  );
  assert.equal(result.stderr, '');
  assert.equal(result.stdout.trim(), 'legacy primary state retained; mutation versions 1, 2, 3');
});

void test('empty mSet advances the namespace version without counting a write', () => {
  const namespace = 'primary-coverage-empty-mset';
  try {
    dispatchOp(namespace, { op: 'set', key: 'retained', value: 'value' });
    const before = getNamespaceVersion(namespace);
    const result = dispatchAndBroadcast(namespace, { op: 'mSet', entries: [] });
    assert.equal(result.value, undefined);
    assert.ok(result.version > before);
    assert.deepEqual(dispatchOp(namespace, { op: 'entries' }), [['retained', 'value']]);
    assert.equal((dispatchOp(namespace, { op: 'stats' }) as { sets: number }).sets, 1);
  } finally {
    dispatchAndBroadcast(namespace, { op: 'destroy' });
  }
});

void test('includeTTL on a request without keys returns an empty TTL list', () => {
  const namespace = 'primary-coverage-keyless-ttl';
  try {
    const result = dispatchAndBroadcast(namespace, { op: 'healthCheck', includeTTL: true });
    assert.deepEqual(result, { value: undefined, version: 0, ttls: [] });
    assert.equal(dispatchOp(namespace, { op: 'size' }), 0);
  } finally {
    dispatchAndBroadcast(namespace, { op: 'destroy' });
  }
});

void test('a cached fetch with a request ID succeeds without a fetch group', async () => {
  const namespace = 'primary-coverage-cached-no-group';
  const cache = new LRUCacheClustered<string, string>({ namespace, max: 10 });
  try {
    cache.getCache()!.set('key', 'direct');
    assert.deepEqual(dispatchOp(namespace, { op: 'fetchClaim', key: 'key', requestId: 'reader' }), {
      kind: 'value',
      value: 'direct',
    });
    assert.equal(dispatchOp(namespace, { op: 'fetchRelease', key: 'key', requestId: 'reader' }), false);
  } finally {
    await cache.destroy();
  }
});

void test('a cached follower unregisters while its leader can still store', async () => {
  const namespace = 'primary-coverage-cached-active-group';
  const cache = new LRUCacheClustered<string, string>({ namespace, max: 10 });
  try {
    const leader = dispatchOp(namespace, { op: 'fetchClaim', key: 'key' }) as { token: string };
    const follower = dispatchOp(namespace, { op: 'fetchClaim', key: 'key', requestId: 'reader' }) as {
      generation: string;
    };
    cache.getCache()!.set('key', 'direct');
    assert.deepEqual(
      dispatchOp(namespace, { op: 'fetchClaim', key: 'key', requestId: 'reader', generation: follower.generation }),
      { kind: 'value', value: 'direct' },
    );
    assert.equal(dispatchOp(namespace, { op: 'fetchRelease', key: 'key', requestId: 'reader' }), false);
    assert.equal(dispatchOp(namespace, { op: 'fetchStore', key: 'key', value: 'leader', token: leader.token }), true);
    assert.equal(await cache.get('key'), 'leader');
  } finally {
    await cache.destroy();
  }
});

void test('the last cached follower removes its idle fetch group', async () => {
  const namespace = 'primary-coverage-cached-idle-group';
  const cache = new LRUCacheClustered<string, string>({ namespace, max: 10 });
  try {
    const leader = dispatchOp(namespace, { op: 'fetchClaim', key: 'key' }) as { token: string };
    const follower = dispatchOp(namespace, { op: 'fetchClaim', key: 'key', requestId: 'reader' }) as {
      generation: string;
    };
    assert.equal(dispatchOp(namespace, { op: 'fetchAbort', key: 'key', token: leader.token }), true);
    cache.getCache()!.set('key', 'direct');
    assert.deepEqual(dispatchOp(namespace, { op: 'fetchClaim', key: 'key' }), { kind: 'value', value: 'direct' });
    assert.deepEqual(
      dispatchOp(namespace, { op: 'fetchClaim', key: 'key', requestId: 'reader', generation: follower.generation }),
      { kind: 'value', value: 'direct' },
    );
    assert.equal(dispatchOp(namespace, { op: 'fetchRelease', key: 'key', requestId: 'reader' }), false);
    cache.getCache()!.delete('key');
    assert.throws(
      () => dispatchOp(namespace, { op: 'fetchClaim', key: 'key', generation: follower.generation }),
      /Fetch was superseded/,
      'a completed group must no longer accept requests belonging to its old generation',
    );
  } finally {
    await cache.destroy();
  }
});
