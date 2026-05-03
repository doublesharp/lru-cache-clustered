import cluster from 'node:cluster';
import { setTimeout } from 'node:timers';
import { LRUCacheForClustersAsPromised } from '../../src/index.ts';

if (!cluster.isWorker) throw new Error('worker-fetch-child loaded outside a worker');

const cache = await LRUCacheForClustersAsPromised.getInstance<string, string>({
  namespace: 'integration-fetch',
  max: 10,
});

process.send?.({ kind: 'fetch-ready' });

process.on('message', (msg: { kind?: string }) => {
  if (!msg || msg.kind !== 'start-fetch') return;

  void (async () => {
    let called = false;
    const value = await cache.fetch('shared', async () => {
      called = true;
      process.send?.({ kind: 'fetcher-called' });
      await new Promise((resolve) => setTimeout(resolve, 50));
      return `value-from-${process.pid}`;
    });

    process.send?.({
      kind: 'fetch-result',
      payload: { called, value },
    });

    setTimeout(() => process.exit(0), 50);
  })();
});
