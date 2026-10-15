import assert from 'node:assert/strict';
import cluster from 'node:cluster';
import { setTimeout } from 'node:timers/promises';
import { LRUCacheClustered } from '../../src/index.ts';
import { getDefaultClient } from '../../src/worker.ts';

if (!cluster.isWorker) throw new Error('coverage fixture requires a cluster worker');

async function exerciseSiblingInvalidations() {
  const options = {
    namespace: 'coverage-worker-sibling-mutations',
    max: 10,
    ttl: 60_000,
    localL1: { experimental: true, ttl: 5000 },
  };
  const writer = await LRUCacheClustered.getInstance<string, string>(options);
  const reader = await LRUCacheClustered.getInstance<string, string>(options);
  const warm = async (key: string, expected: string) => {
    assert.equal(await reader.get(key), expected);
    const hits = reader.localStats()!.hits;
    assert.equal(await reader.get(key), expected);
    assert.equal(reader.localStats()!.hits, hits + 1);
  };
  try {
    await writer.set('key', 'before');
    await warm('key', 'before');
    let invalidations = reader.localStats()!.invalidations;
    assert.equal(await writer.delete('missing'), false);
    assert.equal(reader.localStats()!.invalidations, invalidations);
    await warm('key', 'before');
    assert.equal(await writer.delete('key'), true);
    assert.equal(reader.localStats()!.size, 0);
    assert.equal(await reader.get('key'), undefined);

    assert.equal(await writer.setIfAbsent('key', 'inserted'), true);
    await warm('key', 'inserted');
    invalidations = reader.localStats()!.invalidations;
    assert.equal(await writer.setIfAbsent('key', 'must-not-overwrite'), false);
    assert.equal(reader.localStats()!.invalidations, invalidations);
    await warm('key', 'inserted');

    invalidations = reader.localStats()!.invalidations;
    assert.equal(await writer.purgeStale(), false);
    assert.equal(reader.localStats()!.invalidations, invalidations);
    await warm('key', 'inserted');
    await writer.set('stale', 'expired', { ttl: 1 });
    await setTimeout(30);
    assert.equal(await writer.purgeStale(), true);
    assert.equal(reader.localStats()!.size, 0);
    assert.equal(await reader.get('stale'), undefined);
    await warm('key', 'inserted');

    invalidations = reader.localStats()!.invalidations;
    assert.equal(await writer.max(), 10);
    assert.equal(await writer.ttl(), 60_000);
    assert.equal(reader.localStats()!.invalidations, invalidations);
    await warm('key', 'inserted');
    assert.equal(await writer.max(2), 2);
    assert.equal(reader.localStats()!.size, 0);
    await warm('key', 'inserted');
    assert.equal(await writer.ttl(30_000), 30_000);
    assert.equal(reader.localStats()!.size, 0);
    await warm('key', 'inserted');
  } finally {
    await reader.destroy();
    await writer.destroy();
  }
}

async function exerciseFailedFollowerCleanup() {
  const namespace = 'coverage-worker-failed-release';
  const options = { namespace, max: 10 };
  const leader = await LRUCacheClustered.getInstance<string, string>(options);
  const follower = await LRUCacheClustered.getInstance<string, string>(options);
  let release!: () => void;
  let started!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const start = new Promise<void>((resolve) => {
    started = resolve;
  });
  const leaderFailure = new Error('original leader failure');
  const pendingLeader = leader
    .fetch('key', async () => {
      started();
      await gate;
      throw leaderFailure;
    })
    .catch((error: unknown) => error);
  await start;

  const client = getDefaultClient();
  const originalSend = client.sendToPrimaryWithMeta;
  const timeoutFailure = new Error('lost follower acknowledgement');
  let generation: string | undefined;
  let releaseAttempts = 0;
  let followerCalls = 0;
  client.sendToPrimaryWithMeta = async <T>(...args: Parameters<typeof originalSend>) => {
    if (args[1].op === 'fetchRelease') {
      releaseAttempts++;
      throw new Error('cleanup transport unavailable');
    }
    const response = await originalSend<T>(...args);
    const claim = response.value as { kind?: string; generation?: string };
    if (args[1].op === 'fetchClaim' && claim.kind === 'follower') {
      generation = claim.generation;
      throw timeoutFailure;
    }
    return response;
  };
  try {
    await assert.rejects(
      follower.fetch('key', () => {
        followerCalls++;
        return 'must-not-run';
      }),
      (error: unknown) => error === timeoutFailure,
    );
    assert.equal(releaseAttempts, 1);
    assert.equal(followerCalls, 0);
    assert.equal(typeof generation, 'string');
  } finally {
    client.sendToPrimaryWithMeta = originalSend;
    release();
    assert.equal(await pendingLeader, leaderFailure);
  }
  // Leave the registered follower to the real primary disconnect handler.
  return { namespace, generation };
}

try {
  await exerciseSiblingInvalidations();
  const cleanup = await exerciseFailedFollowerCleanup();
  process.send?.({ kind: 'result', cleanup }, () => process.disconnect?.());
} catch (error) {
  process.send?.({ kind: 'error', message: String(error) }, () => process.disconnect?.());
}
