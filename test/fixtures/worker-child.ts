// Worker process: imported by cluster.fork() in cluster.test.ts.
// Performs a sequence of cache ops and reports results back to the primary
// via process.send (a non-LRU message — the cache uses its own IPC channel).
import cluster from 'node:cluster';
import { LRUCacheForClustersAsPromised } from '../../src/index.ts';

if (!cluster.isWorker) throw new Error('worker-child loaded outside a worker');

async function run() {
  const cache = await LRUCacheForClustersAsPromised.getInstance<string, string>({
    namespace: 'integration',
    max: 10,
  });

  await cache.set('k1', 'v1');
  const v1 = await cache.get('k1');

  await cache.mSet([
    ['a', '1'],
    ['b', '2'],
  ]);
  const got = await cache.mGet(['a', 'b', 'missing']);

  const counter = await cache.incr('hits', 3);

  process.send?.({
    kind: 'integration-results',
    payload: { v1, got: [...got.entries()], counter },
  });
}

void run();
