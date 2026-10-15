import cluster from 'node:cluster';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

if (!cluster.isWorker) throw new Error('module-interop-child must run in a cluster worker');

async function main(): Promise<unknown> {
  const directory = process.env.MODULE_INTEROP_DIRECTORY;
  const namespace = process.env.namespace;
  if (!directory || !namespace) throw new Error('missing mixed-module fixture configuration');
  const esm = (await import(
    pathToFileURL(path.join(directory, 'index.mjs')).href
  )) as typeof import('../../src/index.ts');
  const cjs = createRequire(import.meta.url)(path.join(directory, 'index.cjs')) as typeof import('../../src/index.ts');
  const aOptions = { namespace: `${namespace}-a`, max: 100, failsafe: 'reject' as const };
  const bOptions = { namespace: `${namespace}-b`, max: 100, failsafe: 'reject' as const };
  const initialization = process.env.MODULE_INTEROP_MODE === 'init';
  // Even a broken client may settle both promises on the first response. Drain
  // the actual replies before disconnecting so the regression fails on values.
  const allResponses = new Promise<void>((resolve) => {
    let received = 0;
    const onResponse = (raw: unknown) => {
      if (
        typeof raw !== 'object' ||
        raw === null ||
        !('source' in raw) ||
        raw.source !== 'lcfcap' ||
        !('ok' in raw) ||
        typeof raw.ok !== 'boolean'
      )
        return;
      if (++received === (initialization ? 2 : 4)) {
        process.off('message', onResponse);
        resolve();
      }
    };
    process.on('message', onResponse);
  });
  if (initialization) {
    const outcomes = await Promise.allSettled([
      esm.LRUCacheClustered.getInstance(aOptions),
      cjs.LRUCacheClustered.getInstance({ ...bOptions, max: 10 }),
    ]);
    await allResponses;
    return outcomes.map((outcome) => outcome.status);
  }
  const a = await esm.LRUCacheClustered.getInstance<string, string>(aOptions);
  const b = await cjs.LRUCacheClustered.getInstance<string, string>(bOptions);
  const values = await Promise.all([a.get('key'), b.get('key')]);
  await allResponses;
  return values;
}

main().then(
  (value) => process.send?.({ kind: 'module-interop-result', value }, () => process.disconnect?.()),
  (error: unknown) => {
    console.error(error);
    process.exitCode = 1;
    process.disconnect?.();
  },
);
