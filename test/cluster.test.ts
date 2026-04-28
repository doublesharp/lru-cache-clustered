import test from 'node:test';
import assert from 'node:assert/strict';
import cluster from 'node:cluster';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as setTimer, clearTimeout as clearTimer } from 'node:timers';
import { LRUCacheForClustersAsPromised } from '../src/index.ts';

const here = path.dirname(fileURLToPath(import.meta.url));

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
