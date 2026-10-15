import assert from 'node:assert/strict';
import cluster, { type Worker } from 'node:cluster';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { LRUCacheClustered } from '../src/index.ts';

const SOURCE = 'lru-worker-bench';
type Workload = 'get' | 'mixed95' | 'mget10' | 'fetch';
type Case = { namespace: string; workload: Workload; l1: boolean; iterations: number; payloadBytes: number };
type Result = { samples: number[]; fetcherCalls: number; hits: number };
type Command = { source: typeof SOURCE; command: 'prepare' | 'run'; config: Case };
type Reply = { source: typeof SOURCE; command: Command['command']; result?: Result; error?: string };

function settings(name: string, fallback: string): number[] {
  const values = (process.env[name] ?? fallback).split(',').map(Number);
  assert.ok(
    values.every((v) => Number.isSafeInteger(v) && v > 0),
    `${name} must contain positive integers`,
  );
  return values;
}

function options(config: Case) {
  return {
    namespace: config.namespace,
    max: Math.max(1000, config.iterations + 20),
    timeout: 10_000,
    failsafe: 'reject' as const,
    ...(config.l1 ? { localL1: { experimental: true, ttl: 5000 } } : {}),
  };
}

function value(config: Case): string {
  return 'x'.repeat(config.payloadBytes);
}

function isReply(raw: unknown): raw is Reply {
  return typeof raw === 'object' && raw !== null && (raw as Reply).source === SOURCE;
}

async function request(worker: Worker, command: Command['command'], config: Case): Promise<Result | undefined> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error(`benchmark worker ${worker.id} timed out`)), 60_000);
    const finish = (error?: Error, result?: Result) => {
      clearTimeout(timer);
      worker.off('message', receive);
      worker.off('exit', exited);
      worker.off('error', failed);
      if (error) reject(error);
      else resolve(result);
    };
    const exited = () => finish(new Error(`benchmark worker ${worker.id} exited during ${command}`));
    const failed = (error: Error) => finish(error);
    const receive = (raw: unknown) => {
      if (!isReply(raw) || raw.command !== command) return;
      finish(raw.error ? new Error(raw.error) : undefined, raw.result);
    };
    worker.on('message', receive);
    worker.once('exit', exited);
    worker.once('error', failed);
    worker.send({ source: SOURCE, command, config } satisfies Command, (error) => {
      if (error) finish(error);
    });
  });
}

async function runCase(workers: Worker[], config: Case): Promise<void> {
  const primary = new LRUCacheClustered<string, string>(options(config));
  let requests = 0;
  const count = (raw: unknown) => {
    if (typeof raw === 'object' && raw !== null && (raw as { source?: string }).source === 'lcfcap') requests++;
  };
  try {
    await primary.mSet(Array.from({ length: 10 }, (_, i) => [`key-${i}`, value(config)]));
    await Promise.all(workers.map((worker) => request(worker, 'prepare', config)));
    for (const worker of workers) worker.on('message', count);
    const start = performance.now();
    const results = await Promise.all(workers.map((worker) => request(worker, 'run', config)));
    const elapsed = performance.now() - start;
    const samples = results.flatMap((r) => r!.samples).sort((a, b) => a - b);
    assert.equal(samples.length, workers.length * config.iterations);
    const fetcherCalls = results.reduce((sum, r) => sum + r!.fetcherCalls, 0);
    if (config.workload === 'fetch') assert.equal(fetcherCalls, config.iterations, 'one fetcher per shared key');
    const mean = samples.reduce((sum, sample) => sum + sample, 0) / samples.length;
    const percentile = (p: number) => samples[Math.min(samples.length - 1, Math.floor(samples.length * p))]!;
    console.log(
      JSON.stringify({
        workers: workers.length,
        payloadBytes: config.payloadBytes,
        workload: config.workload,
        l1: config.l1,
        operations: samples.length,
        opsPerSecond: Math.round((samples.length * 1000) / elapsed),
        meanUs: Number(mean.toFixed(2)),
        p95Us: Number(percentile(0.95).toFixed(2)),
        p99Us: Number(percentile(0.99).toFixed(2)),
        ipcRequests: requests,
        localHits: results.reduce((sum, r) => sum + r!.hits, 0),
        fetcherCalls,
      }),
    );
  } finally {
    for (const worker of workers) worker.off('message', count);
    await primary.destroy();
  }
}

async function primaryMain(): Promise<void> {
  const workerCounts = settings('BENCH_WORKERS', '2');
  const payloadSizes = settings('BENCH_PAYLOAD_BYTES', '128,16384');
  const iterations = settings('BENCH_ITERATIONS', '1000')[0]!;
  const serialization = process.env.BENCH_SERIALIZATION ?? 'json';
  assert.ok(serialization === 'json' || serialization === 'advanced', 'BENCH_SERIALIZATION must be json or advanced');
  console.log(JSON.stringify({ node: process.version, serialization, workerCounts, payloadSizes, iterations }));
  cluster.setupPrimary({ exec: fileURLToPath(import.meta.url), execArgv: ['--import', 'tsx'], serialization });
  for (const count of workerCounts) {
    const workers: Worker[] = [];
    try {
      for (let i = 0; i < count; i++) {
        const worker = cluster.fork();
        workers.push(worker);
        await once(worker, 'message', { signal: AbortSignal.timeout(10_000) });
      }
      for (const payloadBytes of payloadSizes) {
        for (const workload of ['get', 'mixed95', 'mget10', 'fetch'] as const) {
          for (const l1 of [false, true]) {
            await runCase(workers, {
              namespace: `bench-${count}-${payloadBytes}-${workload}-${l1}`,
              workload,
              l1,
              iterations: workload === 'fetch' ? Math.min(iterations, 50) : iterations,
              payloadBytes,
            });
          }
        }
      }
    } finally {
      await Promise.all(
        workers.map(async (worker) => {
          if (worker.isDead()) return;
          const exited = once(worker, 'exit');
          worker.kill();
          await exited;
        }),
      );
    }
  }
}

async function workerMain(): Promise<void> {
  let cache: LRUCacheClustered<string, string> | undefined;
  process.on('message', (raw: unknown) => {
    if (typeof raw !== 'object' || raw === null || (raw as Command).source !== SOURCE) return;
    const { command, config } = raw as Command;
    void (async () => {
      if (command === 'prepare') {
        cache = await LRUCacheClustered.getInstance<string, string>(options(config));
        for (let i = 0; i < 20; i++) assert.equal(await cache.get('key-0'), value(config));
        if (config.workload === 'mget10') await cache.mGet(Array.from({ length: 10 }, (_, i) => `key-${i}`));
        process.send!({ source: SOURCE, command } satisfies Reply);
        return;
      }
      assert.ok(cache);
      const samples: number[] = [];
      let fetcherCalls = 0;
      const hitsBefore = cache.localStats()?.hits ?? 0;
      const expected = value(config);
      const keys = Array.from({ length: 10 }, (_, i) => `key-${i}`);
      for (let i = 0; i < config.iterations; i++) {
        const start = performance.now();
        let actual: unknown;
        if (config.workload === 'mixed95' && i % 20 === 0) {
          actual = await cache.set(`writer-${cluster.worker!.id}`, String(i));
        } else if (config.workload === 'mget10') {
          actual = await cache.mGet(keys);
        } else if (config.workload === 'fetch') {
          actual = await cache.fetch(`fetch-${i}`, async () => {
            fetcherCalls++;
            await new Promise((resolve) => setTimeout(resolve, 5));
            return `${i}:${expected}`;
          });
        } else {
          actual = await cache.get('key-0');
        }
        samples.push((performance.now() - start) * 1000);
        if (config.workload === 'mixed95' && i % 20 === 0) assert.equal(actual, true);
        else if (config.workload === 'mget10') assert.deepEqual(actual, new Map(keys.map((key) => [key, expected])));
        else assert.equal(actual, config.workload === 'fetch' ? `${i}:${expected}` : expected);
      }
      const result = { samples, fetcherCalls, hits: (cache.localStats()?.hits ?? 0) - hitsBefore };
      process.send!({ source: SOURCE, command, result } satisfies Reply);
    })().catch((error: unknown) => {
      process.send!({
        source: SOURCE,
        command,
        error: error instanceof Error ? error.message : String(error),
      } satisfies Reply);
    });
  });
  process.send!({ source: SOURCE, ready: true });
}

if (cluster.isPrimary) await primaryMain();
else await workerMain();
