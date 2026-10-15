import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { LRUCacheClustered } from '../src/index.ts';
import { caches } from '../src/primary.ts';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

for (const mutation of ['delete', 'clear', 'load', 'destroy', 'set'] as const) {
  void test(`polling follower is superseded by ${mutation}`, async () => {
    const namespace = `follower-superseded-${mutation}`;
    const options = { namespace, max: 10 };
    const leader = new LRUCacheClustered<string, string>(options);
    const follower = new LRUCacheClustered<string, string>(options);
    const gate = deferred();
    const started = deferred();
    const pendingLeader = leader
      .fetch('key', async () => {
        started.resolve();
        await gate.promise;
        return 'old-leader';
      })
      .catch((error: unknown) => error);
    await started.promise;
    let followerCalls = 0;
    const pendingFollower = follower
      .fetch('key', () => {
        followerCalls++;
        return 'old-follower';
      })
      .catch((error: unknown) => error);
    // Primary dispatch is synchronous; the immediate lets its continuation
    // install the follower poll timer before the mutation.
    await setImmediate();
    try {
      if (mutation === 'load') await leader.load([]);
      else if (mutation === 'set') await leader.set('key', 'new');
      else if (mutation === 'delete') await leader.delete('key');
      else await leader[mutation]();
      const result = await pendingFollower;
      assert.equal(followerCalls, 0, 'the old follower must never run its fetcher');
      if (mutation === 'set') assert.equal(result, 'new');
      else {
        assert.ok(result instanceof Error);
        assert.match(result.message, /superseded.*no current value/i);
      }
      if (mutation === 'destroy') assert.equal(caches.has(namespace), false);
      else assert.equal(caches.get(namespace)?.get('key'), mutation === 'set' ? 'new' : undefined);
    } finally {
      gate.resolve();
      await pendingLeader;
      await leader.destroy();
    }
  });
}

for (const recovery of ['failure', 'lease', 'unrelated'] as const) {
  void test(`polling follower retains ${recovery} recovery`, async (t) => {
    const options = { namespace: `follower-recovery-${recovery}`, max: 10 };
    const leader = new LRUCacheClustered<string, string>(options);
    const follower = new LRUCacheClustered<string, string>(options);
    const gate = deferred();
    const started = deferred();
    let now = Date.now();
    if (recovery === 'lease') t.mock.method(Date, 'now', () => now);
    const pendingLeader = leader
      .fetch('key', async () => {
        started.resolve();
        await gate.promise;
        if (recovery === 'failure') throw new Error('leader failed');
        return 'leader';
      })
      .catch((error: unknown) => error);
    await started.promise;
    let followerCalls = 0;
    const pendingFollower = follower.fetch('key', () => {
      followerCalls++;
      return 'recovered';
    });
    await setImmediate();
    try {
      if (recovery === 'lease') now += 30_001;
      else {
        if (recovery === 'unrelated') await leader.set('other', 'other');
        gate.resolve();
      }
      assert.equal(await pendingFollower, recovery === 'unrelated' ? 'leader' : 'recovered');
      assert.equal(followerCalls, recovery === 'unrelated' ? 0 : 1);
    } finally {
      gate.resolve();
      await pendingLeader;
      await leader.destroy();
    }
  });
}

void test('TTL-only L1 removes own capacity evictions and preserves retained hot keys', async () => {
  const cache = new LRUCacheClustered<string, string>({
    namespace: 'ttl-own-capacity-eviction',
    max: 2,
    localL1: { experimental: true, invalidation: 'ttl-only', ttl: 5000 },
  });
  try {
    await cache.set('victim', 'old');
    await cache.set('hot', 'hot');
    await cache.get('victim');
    await cache.get('hot');
    await cache.set('new', 'new');
    assert.equal(await cache.get('victim'), undefined);
    const hits = cache.localStats()?.hits ?? 0;
    assert.equal(await cache.get('hot'), 'hot');
    assert.equal(cache.localStats()?.hits, hits + 1);
  } finally {
    await cache.destroy();
  }
});

void test('follower revocation and own TTL-only evictions survive worker IPC', { timeout: 15_000 }, async () => {
  const { default: cluster } = await import('node:cluster');
  const { fileURLToPath } = await import('node:url');
  cluster.setupPrimary({
    exec: fileURLToPath(new URL('./fixtures/worker-follower-regressions-child.ts', import.meta.url)),
    execArgv: ['--import', 'tsx'],
  });
  const worker = cluster.fork();
  try {
    const results = await new Promise<Array<Record<string, unknown>>>((resolve, reject) => {
      worker.on('error', reject);
      worker.on('message', (message: { kind?: string; results?: Array<Record<string, unknown>>; message?: string }) => {
        if (message.kind === 'result') resolve(message.results!);
        if (message.kind === 'error') reject(new Error(message.message));
      });
      worker.on('exit', (code) => {
        if (code) reject(new Error(`worker exited: ${code}`));
      });
    });
    for (const result of results.slice(0, 5)) {
      assert.equal(result.calls, 0, String(result.mutation));
      if (result.mutation === 'set') {
        assert.equal(result.value, 'new');
        assert.equal(result.leaderValue, 'new');
      } else {
        assert.match(String(result.value), /superseded.*no current value/i);
        assert.match(String(result.leaderValue), /superseded.*no current value/i);
      }
    }
    assert.deepEqual(results[5], { victimMissing: true, hot: 'hot', retainedHit: true });
    assert.equal(results[6]?.timeoutMessage, 'IPC timeout');
    assert.match(String(results[6]?.cleanup), /superseded.*no current value/i);
  } finally {
    if (!worker.isDead()) worker.kill();
  }
});

void test('worker exit preserves follower generation and last follower cleanup removes idle group', async () => {
  const { default: cluster } = await import('node:cluster');
  const { dispatchOp } = await import('../src/primary.ts');
  const namespace = 'follower-worker-exit';
  const claim = (requestId: string, workerId: number, generation?: string) =>
    dispatchOp(namespace, { op: 'fetchClaim', key: 'key', requestId, generation }, { workerId }) as {
      kind: string;
      token: string;
      generation: string;
    };
  const leader = claim('leader', 9001);
  const follower = claim('follower', 9002);
  assert.equal(follower.kind, 'follower');
  cluster.emit('exit', { id: 9001 });
  const takeover = claim('follower', 9002, follower.generation);
  assert.equal(takeover.kind, 'leader');
  assert.notEqual(takeover.token, leader.token);
  dispatchOp(namespace, { op: 'fetchAbort', key: 'key', token: takeover.token });
  assert.equal(
    dispatchOp(namespace, { op: 'fetchRelease', key: 'key', generation: follower.generation, requestId: 'follower' }),
    true,
  );
  assert.throws(() => claim('follower', 9002, follower.generation), /superseded.*no current value/i);
  dispatchOp(namespace, { op: 'destroy' });
});

void test('disconnected followers cannot retain an idle fetch group', async () => {
  const { default: cluster } = await import('node:cluster');
  const { dispatchOp } = await import('../src/primary.ts');
  const namespace = 'follower-worker-disconnect';
  const leader = dispatchOp(namespace, { op: 'fetchClaim', key: 'key' }, { workerId: 9101 }) as { token: string };
  const follower = dispatchOp(
    namespace,
    { op: 'fetchClaim', key: 'key', requestId: 'disconnecting' },
    { workerId: 9102 },
  ) as { generation: string };
  dispatchOp(namespace, { op: 'fetchAbort', key: 'key', token: leader.token });
  cluster.emit('disconnect', { id: 9102 });
  assert.throws(
    () => dispatchOp(namespace, { op: 'fetchClaim', key: 'key', generation: follower.generation }),
    /superseded.*no current value/i,
  );
  dispatchOp(namespace, { op: 'destroy' });
});
