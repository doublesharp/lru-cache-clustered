// Worker process: imported by cluster.fork() in cluster.test.ts.
// Performs a sequence of cache ops and reports results back to the primary
// via process.send (a non-LRU message — the cache uses its own IPC channel).
import cluster from 'node:cluster';
import { setTimeout } from 'node:timers';
import { LRUCacheForClustersAsPromised } from '../../src/index.ts';

if (!cluster.isWorker) throw new Error('worker-child loaded outside a worker');

async function run() {
  // Construct without noInit: exercises the worker-side init dispatch path.
  new LRUCacheForClustersAsPromised({ namespace: 'integration-init', max: 5 });

  // Worker-only error paths.
  let getAllCachesThrew = false;
  try {
    LRUCacheForClustersAsPromised.getAllCaches();
  } catch {
    getAllCachesThrew = true;
  }
  let getCacheThrew = false;
  try {
    new LRUCacheForClustersAsPromised({ namespace: 'integration-getcache', max: 5, noInit: true }).getCache();
  } catch {
    getCacheThrew = true;
  }

  const cache = await LRUCacheForClustersAsPromised.getInstance<string, string>({
    namespace: 'integration',
    max: 10,
  });
  await cache.healthCheck();

  await cache.set('k1', 'v1');
  const v1 = await cache.get('k1');

  await cache.mSet([
    ['a', '1'],
    ['b', '2'],
  ]);
  const got = await cache.mGet(['a', 'b', 'missing']);

  const counter = await cache.incr('hits', 3);

  const ephemeral = await LRUCacheForClustersAsPromised.getInstance<string, string>({
    namespace: 'integration-destroy',
    max: 5,
    ttl: 1_000,
  });
  await ephemeral.set('before', 'x');
  const destroyed = await ephemeral.destroy();
  await ephemeral.set('after', 'y');
  const recreatedTtl = await ephemeral.getRemainingTTL('after');

  process.send?.({
    kind: 'integration-results',
    payload: {
      v1,
      got: [...got.entries()],
      counter,
      destroyed,
      recreatedTtl,
      getAllCachesThrew,
      getCacheThrew,
    },
  });

  // Give the IPC message time to be delivered, then exit cleanly so V8 writes
  // coverage data (worker.kill() in the parent would skip the V8 exit hooks).
  setTimeout(() => process.exit(0), 50);
}

void run();
