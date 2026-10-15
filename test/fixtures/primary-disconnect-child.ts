import cluster from 'node:cluster';
import { fileURLToPath } from 'node:url';
import { SOURCE } from '../../src/messages.ts';
import { dispatchAndBroadcast, installClusterListener } from '../../src/primary.ts';

if (cluster.isPrimary) {
  installClusterListener();
  dispatchAndBroadcast('primary-disconnect', { op: 'set', key: 'large', value: 'x'.repeat(5 * 1024 * 1024) });
  cluster.setupPrimary({ exec: fileURLToPath(import.meta.url), execArgv: ['--import', 'tsx'] });
  const workers = Array.from({ length: 8 }, () => cluster.fork());
  await Promise.all(workers.map((worker) => new Promise<void>((resolve) => worker.once('exit', () => resolve()))));
  console.log('survived all disconnects');
} else {
  const op = process.argv[2] === 'broadcast' ? 'set' : 'get';
  process.send?.(
    { source: SOURCE, namespace: 'primary-disconnect', id: 'disconnect', op, key: 'large', value: 'new' },
    () => process.exit(0),
  );
}
