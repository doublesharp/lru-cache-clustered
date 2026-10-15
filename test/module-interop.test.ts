import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import cluster from 'node:cluster';
import { mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout, clearTimeout } from 'node:timers';
import { fileURLToPath } from 'node:url';
import { build } from 'tsup';
import { LRUCacheClustered } from '../src/index.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
let buildDirectory: string;

before(async () => {
  buildDirectory = await mkdtemp(path.join(tmpdir(), 'lru-module-interop-'));
  // External dependencies resolve from the isolated bundles without touching dist.
  await symlink(path.join(root, 'node_modules'), path.join(buildDirectory, 'node_modules'), 'dir');
  await build({
    config: false,
    entry: [path.join(root, 'src/index.ts')],
    format: ['esm', 'cjs'],
    outDir: buildDirectory,
    outExtension: ({ format }) => ({ js: format === 'esm' ? '.mjs' : '.cjs' }),
    target: 'node22',
    splitting: false,
    dts: false,
    silent: true,
  });
});

after(async () => {
  if (buildDirectory) await rm(buildDirectory, { recursive: true, force: true });
});

function runMixedWorker(mode: 'get' | 'init', namespace: string): Promise<unknown> {
  cluster.setupPrimary({
    exec: path.join(root, 'test/fixtures/module-interop-child.ts'),
    execArgv: ['--import', 'tsx'],
    serialization: 'advanced',
  });
  const worker = cluster.fork({ MODULE_INTEROP_DIRECTORY: buildDirectory, MODULE_INTEROP_MODE: mode, namespace });
  return new Promise((resolve, reject) => {
    let result: unknown;
    let received = false;
    const timer = setTimeout(() => {
      worker.kill();
      reject(new Error('mixed-module worker timed out'));
    }, 10_000);
    worker.on('message', (message: unknown) => {
      if (typeof message !== 'object' || message === null || !('kind' in message)) return;
      if (message.kind === 'module-interop-result' && 'value' in message) {
        result = message.value;
        received = true;
      }
    });
    worker.once('error', (error) => {
      clearTimeout(timer);
      worker.kill();
      reject(error);
    });
    worker.once('exit', (code) => {
      clearTimeout(timer);
      if (code !== 0 || !received) reject(new Error(`mixed-module worker exited without a result: ${code}`));
      else resolve(result);
    });
  });
}

void test('ESM and CommonJS workers correlate simultaneous reads with distinct namespaces', async () => {
  const namespace = 'module-interop-get';
  const a = new LRUCacheClustered<string, string>({ namespace: `${namespace}-a`, max: 100 });
  const b = new LRUCacheClustered<string, string>({ namespace: `${namespace}-b`, max: 100 });
  try {
    await a.set('key', 'A');
    await b.set('key', 'B');
    assert.deepEqual(await runMixedWorker('get', namespace), ['A', 'B']);
  } finally {
    await a.destroy();
    await b.destroy();
  }
});

void test('ESM and CommonJS workers correlate simultaneous initialization success and failure', async () => {
  const namespace = 'module-interop-init';
  const a = new LRUCacheClustered({ namespace: `${namespace}-a`, max: 100 });
  const b = new LRUCacheClustered({ namespace: `${namespace}-b`, max: 100 });
  try {
    assert.deepEqual(await runMixedWorker('init', namespace), ['fulfilled', 'rejected']);
  } finally {
    await a.destroy();
    await b.destroy();
  }
});
