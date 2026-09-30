import test from 'node:test';
import assert from 'node:assert/strict';
import cluster from 'node:cluster';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as setTimer, clearTimeout as clearTimer } from 'node:timers';
import { LRUCacheClustered } from '../src/index.ts';
import type { L1Stats } from '../src/l1.ts';
import { SOURCE } from '../src/messages.ts';

const here = path.dirname(fileURLToPath(import.meta.url));

type HarnessResponse =
  | { kind: 'ready'; workerId?: number }
  | { kind: 'resp'; id: string; ok: true; value: unknown }
  | { kind: 'resp'; id: string; ok: false; error: { name: string; message: string } };

let nextCommandId = 0;

function setupHarness() {
  cluster.setupPrimary({
    exec: path.join(here, 'fixtures', 'worker-harness.ts'),
    execArgv: ['--import', 'tsx'],
    serialization: 'advanced',
  });
}

async function forkWorker() {
  const w = cluster.fork();
  const pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  const exitP = new Promise<void>((resolve, reject) => {
    w.once('error', reject);
    w.once('exit', (code) => {
      for (const { reject } of pending.values()) reject(new Error('worker exited'));
      pending.clear();
      if (code === 0 || code === null) resolve();
      else reject(new Error(`worker exited code ${code}`));
    });
  });
  await new Promise<void>((resolve, reject) => {
    const t = setTimer(() => reject(new Error('worker not ready')), 10_000);
    w.on('message', (msg: HarnessResponse) => {
      if (msg.kind === 'ready') {
        clearTimer(t);
        resolve();
        return;
      }
      if (msg.kind === 'resp') {
        const cb = pending.get(msg.id);
        if (!cb) return;
        pending.delete(msg.id);
        if (msg.ok) cb.resolve(msg.value);
        else cb.reject(new Error(msg.error.message));
      }
    });
  });
  const send = <T>(cmd: string, args?: unknown): Promise<T> => {
    const id = String(++nextCommandId);
    return new Promise<T>((resolve, reject) => {
      pending.set(id, { resolve: (v) => resolve(v as T), reject });
      w.send({ kind: 'cmd', id, cmd, args });
    });
  };
  const stop = async () => {
    if (w.isDead()) return;
    try {
      await send('exit');
    } catch {
      /* ignore */
    }
    await exitP;
  };
  return { worker: w, send, stop };
}

void test(
  'L1 invalidation: worker A reads, worker B writes, worker A re-reads sees new value',
  { timeout: 15_000 },
  async () => {
    // Pre-create the namespace on primary so workers can find it.
    new LRUCacheClustered({ namespace: 'l1-xworker', max: 100, ttl: 60_000 });
    setupHarness();

    const a = await forkWorker();
    const b = await forkWorker();

    const opts = {
      namespace: 'l1-xworker',
      max: 100,
      ttl: 60_000,
      localL1: { enabled: true, experimental: true, ttl: 5_000 },
    };

    try {
      await a.send('openLocal', opts);
      await b.send('set', { options: opts, key: 'k', value: 'first' });
      const read = () =>
        a.send<{ value: string; stats: L1Stats }>('readLocal', { namespace: opts.namespace, key: 'k' });
      assert.equal((await read()).value, 'first');
      const warm = await read();
      assert.equal(warm.value, 'first');
      assert.equal(warm.stats.hits, 1, 'verify the same L1 is actually warm');
      assert.equal(warm.stats.size, 1);

      await b.send('set', { options: opts, key: 'k', value: 'second' });
      const invalidated = await a.send<L1Stats>('statsLocal', { namespace: opts.namespace });
      assert.equal(invalidated.size, 0);
      assert.equal(invalidated.invalidations, warm.stats.invalidations + 1);
      const fresh = await read();
      assert.equal(fresh.value, 'second');
      assert.equal(fresh.stats.hits, warm.stats.hits, 'the first read after invalidation misses L1');
      assert.equal((await read()).stats.hits, warm.stats.hits + 1);
    } finally {
      await Promise.all([a.stop(), b.stop()]);
    }
  },
);

void test('a reused worker cache restores IPC invalidations after destroy', { timeout: 15_000 }, async () => {
  const options = { namespace: 'l1-worker-reused', max: 100, ttl: 60_000 };
  const primary = new LRUCacheClustered<string, string>(options);
  setupHarness();
  const worker = await forkWorker();
  try {
    await worker.send('openLocal', { ...options, localL1: { experimental: true, ttl: 5000 } });
    await primary.set('key', 'before');
    assert.equal(await worker.send('destroyLocal', { namespace: options.namespace }), true);
    await primary.set('key', 'recreated');
    const read = () =>
      worker.send<{ value: string; stats: L1Stats }>('readLocal', { namespace: options.namespace, key: 'key' });
    assert.equal((await read()).value, 'recreated');
    const warm = await read();
    assert.equal(warm.stats.hits, 1);
    await primary.set('key', 'updated');
    const invalidated = await worker.send<L1Stats>('statsLocal', { namespace: options.namespace });
    assert.equal(invalidated.size, 0);
    assert.equal((await read()).value, 'updated');
  } finally {
    await worker.stop();
    await primary.destroy();
  }
});

void test(
  'failed worker initialization does not subscribe an unreachable L1 instance',
  { timeout: 15_000 },
  async () => {
    const options = { namespace: 'l1-worker-failed-init', max: 100 };
    const primary = new LRUCacheClustered(options);
    setupHarness();
    const worker = await forkWorker();
    try {
      const result = await worker.send<{ rejected: boolean; subscriptions: number }>('probeFailedInitSubscription', {
        ...options,
        max: 10,
        localL1: { experimental: true },
      });
      assert.deepEqual(result, { rejected: true, subscriptions: 0 });
    } finally {
      await worker.stop();
      await primary.destroy();
    }
  },
);

void test('worker constructor ready installs local L1 after init', { timeout: 15_000 }, async () => {
  new LRUCacheClustered({ namespace: 'l1-worker-ready', max: 100, ttl: 60_000 });
  setupHarness();

  const worker = await forkWorker();
  try {
    const result = await worker.send<{ localEnabled: boolean }>('probeReady', {
      options: {
        namespace: 'l1-worker-ready',
        max: 100,
        ttl: 60_000,
        localL1: { enabled: true, experimental: true, ttl: 5_000 },
      },
    });
    assert.deepEqual(result, { localEnabled: true });
  } finally {
    await worker.stop();
  }
});

void test('worker destroy unsubscribes IPC L1 invalidations', { timeout: 15_000 }, async () => {
  new LRUCacheClustered({ namespace: 'l1-worker-destroy', max: 100, ttl: 60_000 });
  setupHarness();

  const worker = await forkWorker();
  try {
    const result = await worker.send<{ destroyed: boolean }>('probeReadyDestroy', {
      options: {
        namespace: 'l1-worker-destroy',
        max: 100,
        ttl: 60_000,
        localL1: { enabled: true, experimental: true, ttl: 5_000 },
      },
    });
    assert.deepEqual(result, { destroyed: true });
  } finally {
    await worker.stop();
  }
});

void test('incr from N workers: final count correct, no L1 race', { timeout: 15_000 }, async () => {
  // Pre-create the namespace on primary so workers can find it.
  const primaryCache = new LRUCacheClustered<string, number>({ namespace: 'l1-incr', max: 10 });
  await primaryCache.set('counter', 0);
  setupHarness();

  const N = 4;
  const workers = await Promise.all(Array.from({ length: N }, () => forkWorker()));
  const opts = { namespace: 'l1-incr', max: 10, localL1: { enabled: true, experimental: true, ttl: 1_000 } };

  try {
    for (const worker of workers) {
      await worker.send('openLocal', opts);
      const read = { namespace: opts.namespace, key: 'counter' };
      await worker.send('readLocal', read);
      const warm = await worker.send<{ value: number; stats: L1Stats }>('readLocal', read);
      assert.equal(warm.value, 0);
      assert.equal(warm.stats.hits, 1);
    }
    const PER = 50;
    await Promise.all(workers.map((w) => w.send('incrMany', { options: opts, key: 'counter', count: PER })));
    // Read the final counter through the primary, bypassing all L1.
    const final = await primaryCache.get('counter', { bypassL1: true });
    assert.equal(final, N * PER);
    for (const worker of workers) {
      const result = await worker.send<{ value: number; stats: L1Stats }>('readLocal', {
        namespace: opts.namespace,
        key: 'counter',
      });
      assert.equal(result.value, N * PER);
      assert.equal(result.stats.hits, 1, 'the warmed counter was invalidated');
      assert.equal(result.stats.misses, 2);
    }
  } finally {
    await Promise.all(workers.map((w) => w.stop()));
  }
});

void test('clear from primary invalidates L1 in all workers', { timeout: 15_000 }, async () => {
  // Pre-create the namespace on primary so workers can find it.
  new LRUCacheClustered({ namespace: 'l1-clear-all', max: 100 });
  setupHarness();

  const a = await forkWorker();
  const b = await forkWorker();
  const opts = { namespace: 'l1-clear-all', max: 100, localL1: { enabled: true, experimental: true, ttl: 5_000 } };

  try {
    await a.send('set', { options: opts, key: 'k1', value: 'v1' });
    await a.send('set', { options: opts, key: 'k2', value: 'v2' });
    await b.send('openLocal', opts);
    const read = (key: string) =>
      b.send<{ value?: string; stats: L1Stats }>('readLocal', { namespace: opts.namespace, key });
    assert.equal((await read('k1')).value, 'v1');
    assert.equal((await read('k2')).value, 'v2');
    assert.equal((await read('k1')).stats.hits, 1);
    assert.equal((await read('k2')).stats.size, 2);
    const primaryCache = new LRUCacheClustered({ namespace: 'l1-clear-all' });
    await primaryCache.clear();
    assert.equal((await b.send<L1Stats>('statsLocal', { namespace: opts.namespace })).size, 0);
    assert.equal((await read('k1')).value, undefined);
    assert.equal((await read('k2')).value, undefined);
  } finally {
    await Promise.all([a.stop(), b.stop()]);
  }
});

for (const serialization of ['json', 'advanced'] as const) {
  void test(
    `L1 mGet uses one IPC request and warms the retained instance (${serialization})`,
    { timeout: 15000 },
    async () => {
      const namespace = `l1-batch-${serialization}`;
      const primary = new LRUCacheClustered<string, number>({ namespace, max: 10 });
      await primary.mSet([
        ['a', 1],
        ['b', 2, { ttl: 60000 }],
      ]);
      setupHarness();
      cluster.setupPrimary({ serialization });
      const worker = await forkWorker();
      try {
        await worker.send('openLocal', { namespace, localL1: { experimental: true, ttl: 5000 } });
        const operations: string[] = [];
        worker.worker.on('message', (message: { source?: string; op?: string }) => {
          if (message.source === SOURCE && message.op) operations.push(message.op);
        });
        const args = { namespace, keys: ['b', 'missing', 'a'] };
        const cold = await worker.send<{ value: unknown; stats: L1Stats }>('mGetLocal', args);
        assert.deepEqual(cold.value, [
          ['b', 2],
          ['missing', serialization === 'json' ? null : undefined],
          ['a', 1],
        ]);
        assert.equal(cold.stats.size, 2);
        assert.deepEqual(operations, ['mGet']);
        operations.length = 0;
        const hot = await worker.send<{ value: unknown; stats: L1Stats }>('mGetLocal', { namespace, keys: ['a', 'b'] });
        assert.deepEqual(hot.value, [
          ['a', 1],
          ['b', 2],
        ]);
        assert.equal(hot.stats.hits, 2);
        assert.deepEqual(operations, []);
      } finally {
        await worker.stop();
      }
    },
  );
}

void test('a cold fetch claims and stores in two IPC requests, then hits L1', { timeout: 15000 }, async () => {
  const namespace = 'fetch-ipc-count';
  setupHarness();
  const worker = await forkWorker();
  try {
    await worker.send('openLocal', { namespace, max: 10, localL1: { experimental: true } });
    const ops: string[] = [];
    worker.worker.on('message', (message: { source?: string; op?: string }) => {
      if (message.source === SOURCE && message.op) ops.push(message.op);
    });
    const args = { namespace, key: 'k' };
    const first = await worker.send<{ value: number; stats: L1Stats }>('fetchLocal', args);
    assert.equal(first.value, 42);
    assert.equal(first.stats.size, 1);
    assert.deepEqual(ops, ['fetchClaim', 'fetchStore']);
    ops.length = 0;
    const hot = await worker.send<{ value: number; stats: L1Stats }>('fetchLocal', args);
    assert.equal(hot.value, 42);
    assert.equal(hot.stats.hits, 1);
    assert.deepEqual(ops, []);
  } finally {
    await worker.stop();
  }
});

void test('fetch followers poll once per cycle and populate L1 from the claim result', { timeout: 15000 }, async () => {
  const namespace = 'fetch-follower-ipc-count';
  const primary = new LRUCacheClustered<string, number>({ namespace, max: 10 });
  setupHarness();
  const worker = await forkWorker();
  let release!: () => void;
  let enter!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    enter = resolve;
  });
  const leader = primary.fetch('k', async () => {
    enter();
    await gate;
    return 7;
  });
  try {
    await started;
    await worker.send('openLocal', { namespace, max: 10, localL1: { experimental: true } });
    const ops: string[] = [];
    worker.worker.on('message', (message: { source?: string; op?: string }) => {
      if (message.source !== SOURCE || !message.op) return;
      ops.push(message.op);
      if (ops.filter((op) => op === 'fetchClaim').length === 3) release();
    });
    const result = await worker.send<{ value: number; stats: L1Stats }>('fetchLocal', { namespace, key: 'k' });
    assert.equal(result.value, 7, 'reuse the primary leader, not the worker fetcher');
    assert.equal(await leader, 7);
    assert.ok(ops.length >= 3, 'exercise multiple follower polls');
    assert.ok(
      ops.every((op) => op === 'fetchClaim'),
      `redundant requests: ${ops.join(', ')}`,
    );
    assert.equal(result.stats.size, 1);
    ops.length = 0;
    const hot = await worker.send<{ value: number; stats: L1Stats }>('fetchLocal', { namespace, key: 'k' });
    assert.equal(hot.value, 7);
    assert.equal(hot.stats.hits, 1);
    assert.deepEqual(ops, []);
  } finally {
    release();
    await leader;
    await worker.stop();
  }
});
