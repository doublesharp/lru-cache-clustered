import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import cluster from 'node:cluster';
import { promisify } from 'node:util';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { LRUCacheClustered } from '../src/index.ts';
import { SOURCE, type Request } from '../src/messages.ts';
import { caches, dispatchAndBroadcast, getNamespaceVersion, handleRequest, versions } from '../src/primary.ts';

const runFile = promisify(execFile);
function request(namespace: string, op: string, extra: object = {}) {
  return handleRequest({ id: 'primary-regression', source: SOURCE, namespace, op, ...extra } as Request);
}
function claim(namespace: string, key = 'key') {
  const response = request(namespace, 'fetchClaim', { key });
  assert.ok(response.ok);
  return (response.value as { token: string }).token;
}

for (const op of ['mSet', 'load'] as const) {
  void test(`partial ${op} failure publishes changed primary state`, async () => {
    const namespace = `primary-partial-${op}`;
    const options = { namespace, maxSize: 10, failsafe: 'reject' as const };
    const reader = new LRUCacheClustered<string, string>({ ...options, localL1: { experimental: true, ttl: 5000 } });
    const writer = new LRUCacheClustered<string, string>(options);
    try {
      await writer.set('key', 'old', { size: 1 });
      await reader.get('key');
      const before = getNamespaceVersion(namespace);
      const entries =
        op === 'mSet'
          ? [
              ['key', 'new', { size: 1 }],
              ['bad', 'invalid', { size: 0 }],
            ]
          : [
              ['key', { value: 'new', size: 1 }],
              ['bad', { value: 'invalid', size: 0 }],
            ];
      const response = request(namespace, op, { entries });
      assert.equal(response.ok, false);
      assert.equal(caches.get(namespace)?.get('key'), 'new');
      assert.ok(getNamespaceVersion(namespace) > before, 'partial mutations must advance the version');
      assert.equal(await reader.get('key'), 'new', 'retained primary L1 must receive failed-operation invalidations');
    } finally {
      await reader.destroy();
      await writer.destroy();
    }
  });
}

void test('destroy reclaims namespace version records and recreated writes exceed old responses', () => {
  const baseline = versions.size;
  for (let i = 0; i < 100; i++) {
    const namespace = `primary-churn-${i}`;
    const old = dispatchAndBroadcast(namespace, { op: 'set', key: 'key', value: 'old' }).version;
    const destroyed = dispatchAndBroadcast(namespace, { op: 'destroy' });
    assert.ok(destroyed.version > old);
    assert.equal(versions.has(namespace), false, 'destroy must release the namespace version record');
    assert.equal(getNamespaceVersion(namespace), 0);
    const recreated = dispatchAndBroadcast(namespace, { op: 'set', key: 'key', value: 'new' });
    assert.ok(recreated.version > destroyed.version, 'recreation must reject earlier-generation responses');
    dispatchAndBroadcast(namespace, { op: 'destroy' });
  }
  assert.equal(versions.size, baseline);
});

for (const [op, extra] of [
  ['set', { key: 'key', value: 'explicit' }],
  ['delete', { key: 'key' }],
  ['mSet', { entries: [['key', 'explicit']] }],
  ['mDelete', { keys: ['key'] }],
  ['clear', {}],
  ['load', { entries: [] }],
  ['destroy', {}],
] as const) {
  void test(`${op} supersedes an earlier fetch claim`, () => {
    const namespace = `primary-fetch-supersede-${op}`;
    const token = claim(namespace);
    request(namespace, op, extra);
    const response = request(namespace, 'fetchStore', { key: 'key', value: 'stale', token });
    assert.ok(response.ok);
    assert.equal(response.value, false, 'superseded fetch must not store its result');
    assert.notEqual(caches.get(namespace)?.get('key'), 'stale');
    request(namespace, 'destroy');
  });
}

void test('failed set leaves a fetch claim usable; oversized set supersedes it', () => {
  const namespace = 'primary-fetch-rejected-set';
  request(namespace, 'init', { options: { maxSize: 5 } });
  const token = claim(namespace);
  assert.equal(request(namespace, 'set', { key: 'key', value: 'bad', size: 0 }).ok, false);
  const stored = request(namespace, 'fetchStore', { key: 'key', value: 'fetched', size: 1, token });
  assert.ok(stored.ok);
  assert.equal(stored.value, true);
  request(namespace, 'delete', { key: 'key' });
  const nextToken = claim(namespace);
  request(namespace, 'set', { key: 'key', value: 'too big', size: 6 });
  const superseded = request(namespace, 'fetchStore', { key: 'key', value: 'stale', size: 1, token: nextToken });
  assert.ok(superseded.ok);
  assert.equal(superseded.value, false);
  request(namespace, 'destroy');
});

void test('partial batch failure broadcasts to workers', () => {
  const original = cluster.workers;
  const sent: unknown[] = [];
  (cluster as unknown as { workers: unknown }).workers = {
    '9999': { id: 9999, isConnected: () => true, send: (msg: unknown) => sent.push(msg) },
  };
  try {
    const namespace = 'primary-partial-worker';
    request(namespace, 'init', { options: { maxSize: 5 } });
    const response = request(namespace, 'mSet', {
      entries: [
        ['key', 'new', { size: 1 }],
        ['bad', 'bad', { size: 0 }],
      ],
    });
    assert.equal(response.ok, false);
    assert.equal(sent.length, 1);
    assert.equal((sent[0] as { push: string }).push, 'l1:invalidate-namespace');
  } finally {
    (cluster as unknown as { workers: unknown }).workers = original;
  }
});

for (const mode of ['response', 'broadcast']) {
  void test(`real worker disconnect during ${mode} send does not crash primary`, { timeout: 20000 }, async () => {
    const result = await runFile(
      process.execPath,
      ['--import', 'tsx', fileURLToPath(new URL('./fixtures/primary-disconnect-child.ts', import.meta.url)), mode],
      { timeout: 18000 },
    );
    assert.match(result.stdout, /survived all disconnects/);
    assert.equal(result.stderr, '');
  });
}

void test('a rejected fetchStore after destroy does not recreate namespace state', () => {
  const namespace = 'primary-destroy-late-fetch';
  const token = claim(namespace);
  request(namespace, 'destroy');
  const result = request(namespace, 'fetchStore', { key: 'key', value: 'stale', token });
  assert.ok(result.ok);
  assert.equal(result.value, false);
  assert.equal(caches.has(namespace), false);
});

void test('a capacity eviction invalidates retained L1 and revokes an evicted-key refresh', async () => {
  const namespace = 'primary-eviction-side-effect';
  const reader = new LRUCacheClustered<string, string>({
    namespace,
    max: 1,
    failsafe: 'reject',
    localL1: { experimental: true, ttl: 5000 },
  });
  try {
    await reader.set('key', 'old');
    await reader.get('key');
    const response = request(namespace, 'fetchClaim', { key: 'key', forceRefresh: true });
    assert.ok(response.ok);
    const token = (response.value as { token: string }).token;
    request(namespace, 'set', { key: 'other', value: 'new' });
    assert.equal(await reader.get('key'), undefined, 'capacity eviction must invalidate the removed key');
    const stored = request(namespace, 'fetchStore', { key: 'key', token, value: 'stale' });
    assert.ok(stored.ok);
    assert.equal(stored.value, false);
  } finally {
    await reader.destroy();
  }
});

void test('partial mSet supersedes applied keys but leaves an unapplied key claim usable', () => {
  const namespace = 'primary-batch-partial-claims';
  request(namespace, 'init', { options: { maxSize: 5 } });
  const first = claim(namespace, 'first');
  const failed = claim(namespace, 'failed');
  const result = request(namespace, 'mSet', {
    entries: [
      ['first', 'new', { size: 1 }],
      ['failed', 'bad', { size: 0 }],
    ],
  });
  assert.equal(result.ok, false);
  const stale = request(namespace, 'fetchStore', { key: 'first', token: first, value: 'stale', size: 1 });
  assert.ok(stale.ok);
  assert.equal(stale.value, false);
  const valid = request(namespace, 'fetchStore', { key: 'failed', token: failed, value: 'valid', size: 1 });
  assert.ok(valid.ok);
  assert.equal(valid.value, true);
  request(namespace, 'destroy');
});

void test('capacity eviction preserves an unrelated retained hot key', async () => {
  const namespace = 'primary-targeted-eviction';
  const reader = new LRUCacheClustered<string, string>({
    namespace,
    max: 2,
    failsafe: 'reject',
    localL1: { experimental: true, ttl: 5000 },
  });
  try {
    await reader.set('evicted', 'old');
    await reader.set('hot', 'retained');
    await reader.get('evicted');
    await reader.get('hot');
    const before = reader.localStats()!.ipcAvoided;
    request(namespace, 'set', { key: 'other', value: 'new' });
    assert.equal(await reader.get('hot'), 'retained');
    assert.equal(reader.localStats()!.ipcAvoided, before + 1, 'evict only the keys removed from authoritative storage');
    assert.equal(await reader.get('evicted'), undefined);
  } finally {
    await reader.destroy();
  }
});

void test('existingOnly get does not recreate a destroyed namespace', () => {
  const namespace = 'primary-existing-only';
  request(namespace, 'set', { key: 'key', value: 'old' });
  request(namespace, 'destroy');
  const response = request(namespace, 'get', { key: 'key', existingOnly: true });
  assert.ok(response.ok);
  assert.equal(response.value, undefined);
  assert.equal(caches.has(namespace), false);
});
