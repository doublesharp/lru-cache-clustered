import cluster from 'node:cluster';
import { LRUCacheClustered } from '../src/index.ts';

// Hot-key 99%-reads scenario. Reports mean and p95 latency for both L1
// configurations on the same machine, in primary mode (no IPC overhead in
// either direction). The goal is to confirm L1 is at least as fast as
// no-L1 in the simplest case; cross-worker scenarios live in test/l1-cluster.test.ts.

async function hotKeyReads(label: string, useL1: boolean) {
  const cache = new LRUCacheClustered<string, number>({
    namespace: `bench-${label}-${Date.now()}`,
    max: 1_000,
    ttl: 60_000,
    ...(useL1 ? { localL1: { enabled: true, experimental: true, ttl: 1_000 } } : {}),
  });

  await cache.set('hot', 1);

  // Warm up
  for (let i = 0; i < 1_000; i++) {
    await cache.get('hot');
  }

  const N = 10_000;
  const samples: number[] = new Array(N);
  for (let i = 0; i < N; i++) {
    const start = process.hrtime.bigint();
    await cache.get('hot');
    samples[i] = Number(process.hrtime.bigint() - start);
  }

  samples.sort((a, b) => a - b);
  const mean = samples.reduce((acc, n) => acc + n, 0) / samples.length;
  const median = samples[Math.floor(samples.length * 0.5)] ?? 0;
  const p95 = samples[Math.floor(samples.length * 0.95)] ?? 0;
  const p99 = samples[Math.floor(samples.length * 0.99)] ?? 0;

  console.log(
    `${label.padEnd(8)}: mean=${(mean / 1000).toFixed(2)}us median=${(median / 1000).toFixed(2)}us p95=${(p95 / 1000).toFixed(2)}us p99=${(p99 / 1000).toFixed(2)}us`,
  );
}

if (cluster.isPrimary) {
  console.log(`hotKeyReads (N=10000, primary mode):`);
  await hotKeyReads('no-l1', false);
  await hotKeyReads('l1', true);
}
