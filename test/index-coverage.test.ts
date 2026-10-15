import assert from 'node:assert/strict';
import cluster from 'node:cluster';
import test from 'node:test';
import { setTimeout, clearTimeout } from 'node:timers';
import { fileURLToPath } from 'node:url';
import { LRUCacheClustered } from '../src/index.ts';
import { dispatchOp } from '../src/primary.ts';

void test('Symbol-key capacity evictions preserve primary and TTL-only L1 behavior', async () => {
  const cache = new LRUCacheClustered<string | symbol, string>({
    namespace: 'coverage-symbol-capacity-eviction',
    max: 1,
    localL1: { experimental: true, invalidation: 'ttl-only', ttl: 5000 },
  });
  const symbol = Symbol('uncacheable-in-L1');
  try {
    assert.equal(await cache.set(symbol, 'symbol-value'), true);
    assert.equal(await cache.get(symbol), 'symbol-value');
    assert.equal(cache.localStats()!.size, 0, 'Symbols cannot enter L1');
    assert.equal(await cache.set('retained', 'string-value'), true);
    assert.equal(cache.getCache()!.has(symbol), false);
    assert.equal(await cache.get(symbol), undefined);
    assert.equal(await cache.get('retained'), 'string-value');
    const hits = cache.localStats()!.hits;
    assert.equal(await cache.get('retained'), 'string-value');
    assert.equal(cache.localStats()!.hits, hits + 1);
    assert.equal((await cache.stats()).evictions, 1);
  } finally {
    await cache.destroy();
  }
});

void test(
  'worker conditional mutations invalidate sibling L1 and failed release preserves fetch failure',
  {
    timeout: 15_000,
  },
  async () => {
    cluster.setupPrimary({
      exec: fileURLToPath(new URL('./fixtures/worker-coverage-child.ts', import.meta.url)),
      execArgv: ['--import', 'tsx'],
    });
    const worker = cluster.fork();
    let rejectCompletion!: (error: Error) => void;
    const watchdog = setTimeout(() => {
      worker.kill();
      rejectCompletion(new Error('coverage worker did not complete within 10 seconds'));
    }, 10_000);
    let namespace: string | undefined;
    try {
      const cleanup = await new Promise<{ namespace: string; generation: string }>((resolve, reject) => {
        rejectCompletion = reject;
        let result: { namespace: string; generation: string } | undefined;
        worker.once('error', reject);
        worker.on(
          'message',
          (message: { kind?: string; cleanup?: { namespace: string; generation: string }; message?: string }) => {
            if (message.kind === 'result') result = message.cleanup;
            else if (message.kind === 'error') reject(new Error(message.message));
          },
        );
        worker.once('exit', (code) => {
          clearTimeout(watchdog);
          if (code !== 0 || !result) reject(new Error(`coverage worker exited without a successful result: ${code}`));
          else resolve(result);
        });
      });
      namespace = cleanup.namespace;
      assert.equal(typeof cleanup.generation, 'string');
      assert.throws(
        () => dispatchOp(cleanup.namespace, { op: 'fetchClaim', key: 'key', generation: cleanup.generation }),
        /superseded.*no current value/i,
        'disconnect must remove the follower whose release could not reach primary',
      );
      const recovered = new LRUCacheClustered<string, string>({ namespace: cleanup.namespace, max: 10 });
      assert.equal(await recovered.fetch('key', () => 'recovered'), 'recovered');
      assert.equal(await recovered.get('key'), 'recovered');
    } finally {
      clearTimeout(watchdog);
      if (!worker.isDead()) worker.kill();
      if (namespace) dispatchOp(namespace, { op: 'destroy' });
    }
  },
);
