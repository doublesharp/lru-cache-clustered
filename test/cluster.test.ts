import test from 'node:test';
import assert from 'node:assert/strict';
import cluster from 'node:cluster';
import type { Worker } from 'node:cluster';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as setTimer, clearTimeout as clearTimer } from 'node:timers';
import { LRUCacheForClustersAsPromised } from '../src/index.ts';
import { caches, stats } from '../src/primary.ts';

const here = path.dirname(fileURLToPath(import.meta.url));

type HarnessResponse =
  | { kind: 'ready'; workerId?: number }
  | { kind: 'resp'; id: string; ok: true; value: unknown }
  | { kind: 'resp'; id: string; ok: false; error: { name: string; message: string } };

type HarnessWorker = {
  send: <T = unknown>(cmd: string, args?: unknown) => Promise<T>;
  stop: () => Promise<void>;
  worker: Worker;
};

let nextCommandId = 0;

function setupHarnessPrimary() {
  cluster.setupPrimary({
    exec: path.join(here, 'fixtures', 'worker-harness.ts'),
    execArgv: ['--import', 'tsx'],
    serialization: 'advanced',
  });
}

async function forkHarnessWorker(): Promise<HarnessWorker> {
  const worker = cluster.fork();
  const pending = new Map<
    string,
    {
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
    }
  >();

  const exitPromise = new Promise<void>((resolve, reject) => {
    worker.once('error', reject);
    worker.once('exit', (code) => {
      for (const { reject } of pending.values()) {
        reject(new Error(`worker exited before responding`));
      }
      pending.clear();
      if (code === 0 || code === null) resolve();
      else reject(new Error(`worker exited with code ${code}`));
    });
  });

  await new Promise<void>((resolve, reject) => {
    const timer = setTimer(() => reject(new Error('worker did not become ready')), 10_000);

    const onMessage = (msg: HarnessResponse) => {
      if (msg && msg.kind === 'ready') {
        clearTimer(timer);
        resolve();
        return;
      }
      if (msg && msg.kind === 'resp') {
        const callback = pending.get(msg.id);
        if (!callback) return;
        pending.delete(msg.id);
        if (msg.ok) callback.resolve(msg.value);
        else callback.reject(new Error(msg.error.message));
      }
    };

    worker.on('message', onMessage);
  });

  const send = <T = unknown>(cmd: string, args?: unknown): Promise<T> => {
    const id = String(++nextCommandId);
    return new Promise<T>((resolve, reject) => {
      pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
      });
      worker.send({ kind: 'cmd', id, cmd, args });
    });
  };

  const stop = async () => {
    if (worker.isDead()) return;
    try {
      await send('exit');
    } catch {
      // Exit path is best-effort; if the worker has already terminated we'll
      // let exitPromise report the final state.
    }
    await exitPromise;
  };

  return { worker, send, stop };
}

void test('cluster.fork roundtrip: worker can use IPC cache', { timeout: 15_000 }, async () => {
  // Pre-create the cache on the primary so the worker can find it.
  new LRUCacheForClustersAsPromised({ namespace: 'integration', max: 10 });

  cluster.setupPrimary({
    exec: path.join(here, 'fixtures', 'worker-child.ts'),
    execArgv: ['--import', 'tsx'],
    serialization: 'advanced',
  });

  const result = await new Promise<{
    v1: string;
    got: Array<[string, string | undefined]>;
    counter: number;
    getAllCachesThrew: boolean;
    getCacheThrew: boolean;
  }>((resolve, reject) => {
    const worker = cluster.fork();
    const timer = setTimer(() => {
      worker.kill();
      reject(new Error('worker did not report results'));
    }, 10_000);
    worker.on('message', (msg: { kind?: string; payload?: unknown }) => {
      if (msg && msg.kind === 'integration-results') {
        clearTimer(timer);
        // Don't kill — let the worker exit cleanly so V8 coverage flushes.
        resolve(msg.payload as never);
      }
    });
    worker.on('error', (err) => {
      clearTimer(timer);
      reject(err);
    });
    worker.on('exit', (code) => {
      if (code !== 0 && code !== null) {
        clearTimer(timer);
        reject(new Error(`worker exited with code ${code}`));
      }
    });
  });

  assert.equal(result.v1, 'v1');
  assert.deepEqual(result.got, [
    ['a', '1'],
    ['b', '2'],
    ['missing', undefined],
  ]);
  assert.equal(result.counter, 3);
  assert.equal(result.getAllCachesThrew, true);
  assert.equal(result.getCacheThrew, true);
});

void test(
  'cluster: workers sharing a namespace see each other writes and incr stays atomic',
  { timeout: 20_000 },
  async () => {
    caches.clear();
    stats.clear();

    const namespace = 'integration-shared';
    const primaryCache = new LRUCacheForClustersAsPromised<string, number | string>({ namespace, max: 1000 });

    setupHarnessPrimary();
    const workers = await Promise.all([forkHarnessWorker(), forkHarnessWorker()]);

    try {
      assert.equal(
        await workers[0].send('set', {
          options: { namespace, max: 1000 },
          key: 'visible',
          value: 'yes',
        }),
        true,
      );
      assert.equal(
        await workers[1].send('get', {
          options: { namespace, max: 1000 },
          key: 'visible',
        }),
        'yes',
      );

      await Promise.all(
        workers.map((worker) =>
          worker.send('incrMany', {
            options: { namespace, max: 1000 },
            key: 'counter',
            count: 200,
          }),
        ),
      );

      assert.equal(await primaryCache.get('counter'), 400);
    } finally {
      await Promise.allSettled(workers.map((worker) => worker.stop()));
    }
  },
);

void test(
  'cluster: worker init semantics match the documented ready/getInstance behavior',
  { timeout: 20_000 },
  async () => {
    caches.clear();
    stats.clear();

    const namespace = 'integration-conflict';
    new LRUCacheForClustersAsPromised({ namespace, max: 1 });

    setupHarnessPrimary();
    const worker = await forkHarnessWorker();

    try {
      const ready = await worker.send<{ threw: boolean; value: unknown }>('probeReadyConflict', {
        options: { namespace, max: 2 },
      });
      assert.deepEqual(ready, { threw: false, value: undefined });

      const getInstanceResult = await worker.send<{ ok: boolean; message?: string }>('getInstanceConflict', {
        options: { namespace, max: 2 },
      });
      assert.equal(getInstanceResult.ok, false);
      assert.match(getInstanceResult.message ?? '', /Conflicting options/);
    } finally {
      await worker.stop();
    }
  },
);

void test('cluster: worker timeouts honor failsafe modes over real IPC', { timeout: 20_000 }, async () => {
  caches.clear();
  stats.clear();

  const namespace = 'integration-timeout';
  const primaryCache = new LRUCacheForClustersAsPromised<string, string>({ namespace, max: 10 });
  const inner = primaryCache.getCache();
  assert.ok(inner);

  const originalGet = inner.get.bind(inner);
  (inner as { get: (key: string) => unknown }).get = (key: string) => {
    const end = Date.now() + 100;
    while (Date.now() < end) {
      // Busy-wait on the primary so the worker's own timer can fire.
    }
    return originalGet(key);
  };

  setupHarnessPrimary();
  const worker = await forkHarnessWorker();

  try {
    const resolved = await worker.send<{ status: string; value?: unknown }>('getOutcome', {
      options: { namespace, max: 10, timeout: 20, failsafe: 'resolve' },
      key: 'missing',
    });
    assert.deepEqual(resolved, { status: 'resolved', value: undefined });

    const rejected = await worker.send<{ status: string; message?: string }>('getOutcome', {
      options: { namespace, max: 10, timeout: 20, failsafe: 'reject' },
      key: 'missing',
    });
    assert.equal(rejected.status, 'rejected');
    assert.match(rejected.message ?? '', /timeout/i);
  } finally {
    (inner as { get: (key: string) => unknown }).get = originalGet;
    await worker.stop();
  }
});

void test('cluster: wrapped caches round-trip encoded Buffers across workers', { timeout: 20_000 }, async () => {
  caches.clear();
  stats.clear();

  const namespace = 'integration-codec';
  const primaryCache = new LRUCacheForClustersAsPromised<string, Buffer>({ namespace, max: 10 });

  setupHarnessPrimary();
  const workers = await Promise.all([forkHarnessWorker(), forkHarnessWorker()]);

  try {
    assert.equal(
      await workers[0].send('wrappedSet', {
        options: { namespace, max: 10 },
        key: 'user:42',
        value: { id: 42, name: 'ada' },
      }),
      true,
    );

    const raw = await primaryCache.get('user:42');
    assert.ok(Buffer.isBuffer(raw), 'primary cache should store the encoded Buffer');

    const decoded = await workers[1].send('wrappedGet', {
      options: { namespace, max: 10 },
      key: 'user:42',
    });
    assert.deepEqual(decoded, { id: 42, name: 'ada' });
  } finally {
    await Promise.allSettled(workers.map((worker) => worker.stop()));
  }
});
