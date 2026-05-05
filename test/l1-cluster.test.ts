import test from 'node:test';
import assert from 'node:assert/strict';
import cluster from 'node:cluster';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as setTimer, clearTimeout as clearTimer } from 'node:timers';
import { LRUCacheForClustersAsPromised } from '../src/index.ts';

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
    new LRUCacheForClustersAsPromised({ namespace: 'l1-xworker', max: 100, ttl: 60_000 });
    setupHarness();

    const a = await forkWorker();
    const b = await forkWorker();

    const opts = { namespace: 'l1-xworker', max: 100, ttl: 60_000, localL1: { enabled: true, ttl: 5_000 } };

    try {
      // B writes initial value
      await b.send('set', { options: opts, key: 'k', value: 'first' });
      // A reads - populates A's L1
      const r1 = await a.send<string>('get', { options: opts, key: 'k' });
      assert.equal(r1, 'first');
      // B overwrites
      await b.send('set', { options: opts, key: 'k', value: 'second' });
      // Allow broadcast to propagate (one event-loop tick + IPC roundtrip).
      await new Promise((r) => setTimeout(r, 100));
      // A re-reads - L1 should have been invalidated, so this hits primary.
      const r2 = await a.send<string>('get', { options: opts, key: 'k' });
      assert.equal(r2, 'second');
    } finally {
      await Promise.all([a.stop(), b.stop()]);
    }
  },
);

void test('incr from N workers: final count correct, no L1 race', { timeout: 15_000 }, async () => {
  // Pre-create the namespace on primary so workers can find it.
  new LRUCacheForClustersAsPromised({ namespace: 'l1-incr', max: 10 });
  setupHarness();

  const N = 4;
  const workers = await Promise.all(Array.from({ length: N }, () => forkWorker()));
  const opts = { namespace: 'l1-incr', max: 10, localL1: { enabled: true, ttl: 1_000 } };

  try {
    const PER = 50;
    await Promise.all(workers.map((w) => w.send('incrMany', { options: opts, key: 'counter', count: PER })));
    // Allow any in-flight broadcasts to drain.
    await new Promise((r) => setTimeout(r, 100));
    // Read the final counter through the primary, bypassing all L1.
    const primaryCache = new LRUCacheForClustersAsPromised<string, number>({ namespace: 'l1-incr' });
    const final = await primaryCache.get('counter', { bypassL1: true });
    assert.equal(final, N * PER);
  } finally {
    await Promise.all(workers.map((w) => w.stop()));
  }
});

void test('clear from primary invalidates L1 in all workers', { timeout: 15_000 }, async () => {
  // Pre-create the namespace on primary so workers can find it.
  new LRUCacheForClustersAsPromised({ namespace: 'l1-clear-all', max: 100 });
  setupHarness();

  const a = await forkWorker();
  const b = await forkWorker();
  const opts = { namespace: 'l1-clear-all', max: 100, localL1: { enabled: true, ttl: 5_000 } };

  try {
    await a.send('set', { options: opts, key: 'k1', value: 'v1' });
    await a.send('set', { options: opts, key: 'k2', value: 'v2' });
    // B reads - populates L1 on B
    await b.send('get', { options: opts, key: 'k1' });
    await b.send('get', { options: opts, key: 'k2' });
    // Primary clears
    const primaryCache = new LRUCacheForClustersAsPromised({ namespace: 'l1-clear-all' });
    await primaryCache.clear();
    // Let the broadcast propagate.
    await new Promise((r) => setTimeout(r, 100));
    // B re-reads - both should miss L1 AND miss L2 (cleared).
    const r1 = await b.send('get', { options: opts, key: 'k1' });
    const r2 = await b.send('get', { options: opts, key: 'k2' });
    assert.equal(r1, undefined);
    assert.equal(r2, undefined);
  } finally {
    await Promise.all([a.stop(), b.stop()]);
  }
});
