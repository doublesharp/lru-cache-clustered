import cluster from 'node:cluster';
import { LRUCacheClustered } from '../../src/index.ts';
import { getDefaultClient } from '../../src/worker.ts';

if (!cluster.isWorker) throw new Error('worker fixture requires a cluster worker');

try {
  const results: unknown[] = [];
  for (const mutation of ['delete', 'clear', 'load', 'destroy', 'set'] as const) {
    const options = { namespace: `worker-follower-${mutation}`, max: 10 };
    const leader = new LRUCacheClustered<string, string>(options);
    const follower = new LRUCacheClustered<string, string>(options);
    let release!: () => void;
    let started!: () => void;
    const start = new Promise<void>((resolve) => {
      started = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const pendingLeader = leader
      .fetch('key', async () => {
        started();
        await gate;
        return 'old-leader';
      })
      .catch((error: Error) => error.message);
    await start;
    let calls = 0;
    const pendingFollower = follower
      .fetch('key', () => {
        calls++;
        return 'old-follower';
      })
      .catch((error: Error) => error.message);
    // This IPC barrier follows fetchClaim on the same ordered channel. Its
    // response proves the follower claim was processed before the mutation.
    await follower.healthCheck();
    if (mutation === 'load') await leader.load([]);
    else if (mutation === 'set') await leader.set('key', 'new');
    else if (mutation === 'delete') await leader.delete('key');
    else await leader[mutation]();
    const value = await pendingFollower;
    release();
    const leaderValue = await pendingLeader;
    results.push({ mutation, calls, value, leaderValue });
    await leader.destroy();
  }
  const cache = new LRUCacheClustered<string, string>({
    namespace: 'worker-ttl-own-capacity',
    max: 2,
    localL1: { experimental: true, invalidation: 'ttl-only', ttl: 5000 },
  });
  await cache.set('victim', 'old');
  await cache.set('hot', 'hot');
  await cache.get('victim');
  await cache.get('hot');
  await cache.set('new', 'new');
  const victim = await cache.get('victim');
  const before = cache.localStats()?.hits ?? 0;
  const hot = await cache.get('hot');
  results.push({ victimMissing: victim === undefined, hot, retainedHit: cache.localStats()?.hits === before + 1 });
  await cache.destroy();
  // Simulate the first follower acknowledgement being lost after the primary
  // has registered it. The public fetch must release by its known request ID.
  const timeoutNamespace = 'worker-follower-lost-ack';
  const timeoutLeader = new LRUCacheClustered<string, string>({ namespace: timeoutNamespace, max: 10 });
  const timeoutFollower = new LRUCacheClustered<string, string>({ namespace: timeoutNamespace, max: 10 });
  let releaseFailure!: () => void;
  let leaderStarted!: () => void;
  const failureGate = new Promise<void>((resolve) => {
    releaseFailure = resolve;
  });
  const failureStarted = new Promise<void>((resolve) => {
    leaderStarted = resolve;
  });
  const failedLeader = timeoutLeader
    .fetch('key', async () => {
      leaderStarted();
      await failureGate;
      throw new Error('leader failed');
    })
    .catch((error: Error) => error.message);
  await failureStarted;
  const client = getDefaultClient();
  const send = client.sendToPrimaryWithMeta.bind(client);
  let lostGeneration: string | undefined;
  client.sendToPrimaryWithMeta = async <T>(...args: Parameters<typeof send>) => {
    const result = await send<T>(...args);
    const claim = result.value as { kind?: string; generation?: string };
    if (args[1].op === 'fetchClaim' && claim.kind === 'follower') {
      lostGeneration = claim.generation;
      throw new Error('IPC timeout');
    }
    return result;
  };
  let timeoutMessage: string;
  try {
    timeoutMessage = await timeoutFollower.fetch('key', () => 'must-not-run').catch((error: Error) => error.message);
  } finally {
    client.sendToPrimaryWithMeta = send;
  }
  releaseFailure();
  await failedLeader;
  const cleanup = await send(
    { namespace: timeoutNamespace, timeout: 1000, failsafe: 'reject' },
    { op: 'fetchClaim', key: 'key', generation: lostGeneration, requestId: 'probe' },
  ).then(
    () => 'group leaked',
    (error: Error) => error.message,
  );
  results.push({ timeoutMessage, cleanup });
  await timeoutLeader.destroy();
  process.send?.({ kind: 'result', results }, () => process.disconnect?.());
} catch (error) {
  process.send?.({ kind: 'error', message: String(error) }, () => process.disconnect?.());
}
