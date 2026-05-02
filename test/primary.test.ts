import test from 'node:test';
import assert from 'node:assert/strict';
import cluster from 'node:cluster';
import { getOrCreateCache, caches, handleRequest, installClusterListener, stats } from '../src/primary.ts';
import { SOURCE, deserializeError, serializeError, type Request, type Stats } from '../src/messages.ts';

type PrimaryModule = typeof import('../src/primary.ts');

void test('separately loaded package copies share primary process state', async () => {
  const firstUrl = new URL('../src/primary.ts', import.meta.url);
  firstUrl.search = 'copy=first';
  const secondUrl = new URL('../src/primary.ts', import.meta.url);
  secondUrl.search = 'copy=second';

  const first = (await import(firstUrl.href)) as PrimaryModule;
  const second = (await import(secondUrl.href)) as PrimaryModule;

  first.caches.clear();
  first.stats.clear();
  const cache = first.getOrCreateCache('dual-package', { max: 2 });

  assert.equal(second.caches, first.caches);
  assert.equal(second.stats, first.stats);
  assert.equal(second.caches.get('dual-package'), cache);
});

void test('getOrCreateCache creates a cache for a new namespace', () => {
  caches.clear();
  const cache = getOrCreateCache('alpha', { max: 5 });
  assert.equal(cache.max, 5);
  assert.ok(caches.has('alpha'));
});

void test('getOrCreateCache returns existing cache for known namespace', () => {
  caches.clear();
  const a = getOrCreateCache('beta', { max: 3 });
  const b = getOrCreateCache('beta', { max: 3 });
  assert.equal(a, b);
  assert.equal(a.max, 3);
});

void test('getOrCreateCache reuse allows omitted options', () => {
  caches.clear();
  const a = getOrCreateCache('beta-no-options');
  const b = getOrCreateCache('beta-no-options');
  assert.equal(a, b);
});

function req<T extends { op: string }>(extra: T) {
  return { id: 'req-1', namespace: 'ns-init', source: SOURCE, ...extra };
}

void test('handleRequest op=init creates cache and returns ok', () => {
  caches.clear();
  const r = handleRequest(req({ op: 'init', options: { max: 7 } }));
  assert.equal(r.ok, true);
  assert.deepEqual(r, {
    id: 'req-1',
    source: SOURCE,
    ok: true,
    value: { namespace: 'ns-init', isNew: true, max: 7 },
  });
  assert.ok(caches.has('ns-init'));
});

void test('handleRequest op=init reuses cache and returns isNew=false', () => {
  caches.clear();
  handleRequest(req({ op: 'init', options: { max: 7 } }));
  const r = handleRequest(req({ op: 'init', options: { max: 7 } }));
  assert.equal(r.ok, true);
  assert.deepEqual((r as { value: unknown }).value, {
    namespace: 'ns-init',
    isNew: false,
    max: 7,
  });
});

void test('handleRequest op=init rejects conflicting options for an existing namespace', () => {
  caches.clear();
  stats.clear();
  const first = handleRequest(req({ op: 'init', options: { max: 7, ttl: 1000 } }));
  assert.equal(first.ok, true);

  const second = handleRequest(req({ op: 'init', options: { max: 8 } }));
  assert.equal(second.ok, false);
  assert.match((second as { error: { message: string } }).error.message, /Conflicting options/);
});

void test('handleRequest op=init ignores explicitly undefined options on reuse', () => {
  caches.clear();
  stats.clear();
  const first = handleRequest(req({ op: 'init', options: { max: 7, ttl: 1000 } }));
  assert.equal(first.ok, true);

  const second = handleRequest(req({ op: 'init', options: { max: 7, ttl: undefined } }));
  assert.equal(second.ok, true);
  assert.deepEqual((second as { value: unknown }).value, {
    namespace: 'ns-init',
    isNew: false,
    max: 7,
  });
});

void test('handleRequest op=healthCheck creates or validates a namespace', () => {
  caches.clear();
  stats.clear();
  const r = handleRequest({
    id: 'h',
    namespace: 'health-ns',
    source: SOURCE,
    cacheOptions: { max: 5, ttl: 1_000 },
    op: 'healthCheck',
  });
  assert.equal(r.ok, true);
  assert.ok(caches.has('health-ns'));
});

void test('handleRequest op=healthCheck rejects conflicting cache options', () => {
  caches.clear();
  stats.clear();
  const first = handleRequest({
    id: 'h1',
    namespace: 'health-conflict',
    source: SOURCE,
    cacheOptions: { max: 5, ttl: 1_000 },
    op: 'healthCheck',
  });
  assert.equal(first.ok, true);

  const second = handleRequest({
    id: 'h2',
    namespace: 'health-conflict',
    source: SOURCE,
    cacheOptions: { max: 6 },
    op: 'healthCheck',
  });
  assert.equal(second.ok, false);
  assert.match((second as { error: { message: string } }).error.message, /Conflicting options/);
});

void test('cluster exit releases fetch locks owned by the exited worker', () => {
  caches.clear();
  stats.clear();
  installClusterListener();

  const namespace = 'exit-locks';
  const workerId = 4242;
  const request = (id: string) =>
    ({
      id,
      namespace,
      source: SOURCE,
      cacheOptions: { max: 5 },
      op: 'fetchClaim',
      key: 'shared',
      forceRefresh: false,
    }) as Request;

  const leader = handleRequest(request('leader'), { workerId });
  assert.equal(leader.ok, true);
  assert.equal((leader as { value: { kind: string } }).value.kind, 'leader');

  const blocked = handleRequest(request('blocked'));
  assert.equal(blocked.ok, true);
  assert.deepEqual((blocked as { value: unknown }).value, { kind: 'follower' });

  cluster.emit('exit', { id: workerId });

  const next = handleRequest(request('next'));
  assert.equal(next.ok, true);
  assert.equal((next as { value: { kind: string } }).value.kind, 'leader');
});

void test('installClusterListener attaches handlers to workers that already exist', () => {
  // Reset the install guard so this test can re-run installClusterListener
  // and exercise the existing-workers branch (cluster.on('fork') only fires
  // for future workers, so without iterating cluster.workers, late bootstraps
  // would orphan already-running workers).
  const STATE_KEY = Symbol.for('lru-cache-clustered.primary');
  const state = (globalThis as Record<PropertyKey, unknown>)[STATE_KEY] as {
    clusterListenerInstalled: boolean;
  };
  state.clusterListenerInstalled = false;

  const messageHandlers: Array<(raw: unknown) => void> = [];
  const sentResponses: unknown[] = [];
  const fakeWorker = {
    id: 9001,
    on: (event: string, cb: (raw: unknown) => void) => {
      if (event === 'message') messageHandlers.push(cb);
    },
    isConnected: () => true,
    send: (msg: unknown) => sentResponses.push(msg),
  };

  const originalWorkers = cluster.workers;
  // cluster.workers is a Record<string, Worker | undefined>; populate with a fake
  // before calling installClusterListener, then restore.
  (cluster as unknown as { workers: Record<string, unknown> }).workers = {
    [String(fakeWorker.id)]: fakeWorker,
  };

  try {
    installClusterListener();

    assert.equal(messageHandlers.length, 1, 'existing worker should get exactly one message handler');

    caches.clear();
    const request = {
      id: 'late-1',
      namespace: 'late-bootstrap',
      source: SOURCE,
      cacheOptions: { max: 3 },
      op: 'set',
      key: 'k',
      value: 'v',
    } as Request;
    messageHandlers[0]!(request);

    assert.equal(sentResponses.length, 1);
    assert.equal((sentResponses[0] as { ok: boolean }).ok, true);

    // Non-matching messages are filtered out and never reach handleRequest.
    messageHandlers[0]!({ not: 'ours' });
    assert.equal(sentResponses.length, 1);
  } finally {
    (cluster as unknown as { workers: Record<string, unknown> | undefined }).workers = originalWorkers;
  }
});

void test('worker message handler skips send when worker is no longer connected', () => {
  const STATE_KEY = Symbol.for('lru-cache-clustered.primary');
  const state = (globalThis as Record<PropertyKey, unknown>)[STATE_KEY] as {
    clusterListenerInstalled: boolean;
  };
  state.clusterListenerInstalled = false;

  const messageHandlers: Array<(raw: unknown) => void> = [];
  const sentResponses: unknown[] = [];
  const fakeWorker = {
    id: 9101,
    on: (event: string, cb: (raw: unknown) => void) => {
      if (event === 'message') messageHandlers.push(cb);
    },
    isConnected: () => false,
    send: (msg: unknown) => sentResponses.push(msg),
  };

  const originalWorkers = cluster.workers;
  (cluster as unknown as { workers: Record<string, unknown> }).workers = {
    [String(fakeWorker.id)]: fakeWorker,
  };

  try {
    installClusterListener();
    caches.clear();
    messageHandlers[0]!({
      id: 'late-discon',
      namespace: 'late-bootstrap-2',
      source: SOURCE,
      cacheOptions: { max: 3 },
      op: 'set',
      key: 'k',
      value: 'v',
    });
    assert.equal(sentResponses.length, 0, 'send must be skipped for disconnected workers');
  } finally {
    (cluster as unknown as { workers: Record<string, unknown> | undefined }).workers = originalWorkers;
  }
});

void test('worker message handler swallows send() throws (e.g. channel closed mid-flight)', () => {
  const STATE_KEY = Symbol.for('lru-cache-clustered.primary');
  const state = (globalThis as Record<PropertyKey, unknown>)[STATE_KEY] as {
    clusterListenerInstalled: boolean;
  };
  state.clusterListenerInstalled = false;

  const messageHandlers: Array<(raw: unknown) => void> = [];
  const fakeWorker = {
    id: 9102,
    on: (event: string, cb: (raw: unknown) => void) => {
      if (event === 'message') messageHandlers.push(cb);
    },
    isConnected: () => true,
    send: () => {
      throw new Error('channel closed');
    },
  };

  const originalWorkers = cluster.workers;
  (cluster as unknown as { workers: Record<string, unknown> }).workers = {
    [String(fakeWorker.id)]: fakeWorker,
  };

  try {
    installClusterListener();
    caches.clear();
    // Should not throw out of the listener even though send() does.
    assert.doesNotThrow(() => {
      messageHandlers[0]!({
        id: 'late-throw',
        namespace: 'late-bootstrap-3',
        source: SOURCE,
        cacheOptions: { max: 3 },
        op: 'set',
        key: 'k',
        value: 'v',
      });
    });
  } finally {
    (cluster as unknown as { workers: Record<string, unknown> | undefined }).workers = originalWorkers;
  }
});

void test('isOurRequest filters out messages with non-string namespace', () => {
  const STATE_KEY = Symbol.for('lru-cache-clustered.primary');
  const state = (globalThis as Record<PropertyKey, unknown>)[STATE_KEY] as {
    clusterListenerInstalled: boolean;
  };
  state.clusterListenerInstalled = false;

  const messageHandlers: Array<(raw: unknown) => void> = [];
  const sentResponses: unknown[] = [];
  const fakeWorker = {
    id: 9103,
    on: (event: string, cb: (raw: unknown) => void) => {
      if (event === 'message') messageHandlers.push(cb);
    },
    isConnected: () => true,
    send: (msg: unknown) => sentResponses.push(msg),
  };

  const originalWorkers = cluster.workers;
  (cluster as unknown as { workers: Record<string, unknown> }).workers = {
    [String(fakeWorker.id)]: fakeWorker,
  };

  try {
    installClusterListener();
    const cachesBefore = caches.size;
    // Malformed message: source and id valid, op present, but namespace is undefined.
    // Without the typeof-string guard this would call dispatchOp with namespace=undefined
    // and pollute the registry under that key.
    messageHandlers[0]!({
      id: 'malformed',
      source: SOURCE,
      op: 'init',
      options: { max: 3 },
    });
    assert.equal(sentResponses.length, 0, 'malformed request must be filtered out');
    assert.equal(caches.size, cachesBefore, 'registry must not gain an undefined key');
  } finally {
    (cluster as unknown as { workers: Record<string, unknown> | undefined }).workers = originalWorkers;
  }
});

void test('installClusterListener tolerates undefined cluster.workers entries and missing registry', () => {
  const STATE_KEY = Symbol.for('lru-cache-clustered.primary');
  const state = (globalThis as Record<PropertyKey, unknown>)[STATE_KEY] as {
    clusterListenerInstalled: boolean;
  };
  const originalWorkers = cluster.workers;

  try {
    // cluster.workers can have undefined entries for disconnected slots.
    state.clusterListenerInstalled = false;
    (cluster as unknown as { workers: Record<string, unknown> }).workers = { '1': undefined };
    assert.doesNotThrow(() => installClusterListener());

    // cluster.workers can also be undefined entirely (off-cluster process).
    state.clusterListenerInstalled = false;
    (cluster as unknown as { workers: Record<string, unknown> | undefined }).workers = undefined;
    assert.doesNotThrow(() => installClusterListener());
  } finally {
    (cluster as unknown as { workers: Record<string, unknown> | undefined }).workers = originalWorkers;
  }
});

void test('handleRequest CRUD ops', () => {
  caches.clear();
  const ns = 'crud';
  const init = (op: string, extra: object = {}) =>
    handleRequest({ id: 'r', namespace: ns, source: SOURCE, op, ...extra } as Request);

  init('init', { options: { max: 10 } });

  assert.equal((init('set', { key: 'k', value: 'v' }) as { value: unknown }).value, true);
  assert.equal((init('get', { key: 'k' }) as { value: unknown }).value, 'v');
  assert.equal((init('has', { key: 'k' }) as { value: unknown }).value, true);
  assert.equal((init('peek', { key: 'k' }) as { value: unknown }).value, 'v');
  assert.equal((init('delete', { key: 'k' }) as { value: unknown }).value, true);
  assert.equal((init('get', { key: 'k' }) as { value: unknown }).value, undefined);

  init('set', { key: 'a', value: 1 });
  init('set', { key: 'b', value: 2 });
  assert.equal((init('clear') as { value: unknown }).value, undefined);
  assert.equal((init('get', { key: 'a' }) as { value: unknown }).value, undefined);
});

void test('handleRequest multi ops', () => {
  caches.clear();
  const ns = 'multi';
  const dispatch = (op: string, extra: object = {}) =>
    handleRequest({ id: 'r', namespace: ns, source: SOURCE, op, ...extra } as Request);

  dispatch('init', { options: { max: 100 } });
  dispatch('mSet', {
    entries: [
      ['a', 1],
      ['b', 2],
      ['c', 3],
    ],
  });
  const got = (dispatch('mGet', { keys: ['a', 'b', 'missing'] }) as { value: unknown }).value;
  assert.deepEqual(got, [
    ['a', 1],
    ['b', 2],
    ['missing', undefined],
  ]);

  dispatch('mDelete', { keys: ['a', 'c'] });
  const after = (dispatch('mGet', { keys: ['a', 'b', 'c'] }) as { value: unknown }).value;
  assert.deepEqual(after, [
    ['a', undefined],
    ['b', 2],
    ['c', undefined],
  ]);
});

void test('handleRequest size-bounded writes support per-call and per-entry size', () => {
  caches.clear();
  stats.clear();
  const ns = 'sized';
  const d = (op: string, extra: object = {}) =>
    handleRequest({
      id: 'r',
      namespace: ns,
      source: SOURCE,
      cacheOptions: { maxSize: 10, maxEntrySize: 10 },
      op,
      ...extra,
    } as Request);

  d('healthCheck');
  d('set', { key: 'a', value: 'AA', size: 2 });
  d('setIfAbsent', { key: 'b', value: 'BBB', size: 3 });
  d('mSet', {
    entries: [
      ['c', 'C', { size: 1 }],
      ['d', 'DD', { size: 2 }],
    ],
  });

  assert.equal((d('get', { key: 'a' }) as { value: unknown }).value, 'AA');
  assert.equal((d('get', { key: 'b' }) as { value: unknown }).value, 'BBB');
  assert.equal((d('get', { key: 'c' }) as { value: unknown }).value, 'C');
  assert.equal((d('get', { key: 'd' }) as { value: unknown }).value, 'DD');
});

void test('handleRequest enumeration ops', () => {
  caches.clear();
  const ns = 'enum';
  const d = (op: string, extra: object = {}) =>
    handleRequest({ id: 'r', namespace: ns, source: SOURCE, op, ...extra } as Request);

  d('init', { options: { max: 10 } });
  d('mSet', {
    entries: [
      ['a', 1],
      ['b', 2],
    ],
  });

  assert.deepEqual((d('keys') as { value: unknown }).value, ['b', 'a']); // most recent first
  assert.deepEqual((d('values') as { value: unknown }).value, [2, 1]);
  assert.deepEqual((d('entries') as { value: unknown }).value, [
    ['b', 2],
    ['a', 1],
  ]);
  assert.equal((d('size') as { value: unknown }).value, 2);

  const dump = (d('dump') as { value: unknown }).value;
  assert.ok(Array.isArray(dump));
  assert.equal((dump as unknown[]).length, 2);

  // purgeStale on non-stale entries returns false (no entries were purged)
  assert.equal(typeof (d('purgeStale') as { value: unknown }).value, 'boolean');
});

void test('handleRequest incr/decr', () => {
  caches.clear();
  const ns = 'counter';
  const d = (op: string, extra: object = {}) =>
    handleRequest({ id: 'r', namespace: ns, source: SOURCE, op, ...extra } as Request);

  d('init', { options: { max: 10 } });

  assert.equal((d('incr', { key: 'c' }) as { value: unknown }).value, 1);
  assert.equal((d('incr', { key: 'c' }) as { value: unknown }).value, 2);
  assert.equal((d('incr', { key: 'c', amount: 5 }) as { value: unknown }).value, 7);
  assert.equal((d('decr', { key: 'c' }) as { value: unknown }).value, 6);
  assert.equal((d('decr', { key: 'c', amount: 10 }) as { value: unknown }).value, -4);
});

void test('handleRequest config getters and setters', () => {
  caches.clear();
  const ns = 'cfg';
  const d = (op: string, extra: object = {}) =>
    handleRequest({ id: 'r', namespace: ns, source: SOURCE, op, ...extra } as Request);

  d('init', { options: { max: 10, ttl: 1000 } });
  assert.equal((d('max') as { value: unknown }).value, 10);
  assert.equal((d('max', { value: 50 }) as { value: unknown }).value, 50);
  assert.equal((d('ttl') as { value: unknown }).value, 1000);
  assert.equal((d('ttl', { value: 5000 }) as { value: unknown }).value, 5000);
  assert.equal((d('allowStale') as { value: unknown }).value, false);
  assert.equal((d('allowStale', { value: true }) as { value: unknown }).value, true);
});

void test('handleRequest rejects nullish keys and values', () => {
  caches.clear();
  stats.clear();
  const ns = 'nullish-dispatch';
  const d = (op: string, extra: object = {}) =>
    handleRequest({ id: 'r', namespace: ns, source: SOURCE, op, ...extra } as Request);

  assert.equal(d('set', { key: undefined, value: 'v' }).ok, false);
  assert.equal(d('set', { key: 'k', value: undefined }).ok, false);
  assert.equal(d('get', { key: null }).ok, false);
});

void test('handleRequest returns error for unknown op', () => {
  const r = handleRequest({ id: 'r', namespace: 'x', source: SOURCE, op: 'bogus' } as unknown as Request);
  assert.equal(r.ok, false);
  assert.match((r as { error: { message: string } }).error.message, /unhandled op/);
});

void test('handleRequest catches handler exceptions and returns ok=false', () => {
  caches.clear();
  // Pre-create a cache and break one of its methods to force a throw inside the switch.
  handleRequest({ id: 'i', namespace: 'boom', source: SOURCE, op: 'init', options: { max: 5 } });
  const cache = caches.get('boom');
  assert.ok(cache);
  (cache as { get: (k: unknown) => unknown }).get = () => {
    throw new Error('boom-message');
  };
  const r = handleRequest({ id: 'r', namespace: 'boom', source: SOURCE, op: 'get', key: 'x' });
  assert.equal(r.ok, false);
  assert.match((r as { error: { message: string } }).error.message, /boom-message/);
});

void test('handleRequest max setter rebuilds the cache, preserving entries', () => {
  caches.clear();
  const ns = 'rebuild';
  const d = (op: string, extra: object = {}) =>
    handleRequest({ id: 'r', namespace: ns, source: SOURCE, op, ...extra } as Request);

  d('init', { options: { max: 10, ttl: 1000, allowStale: true } });
  d('set', { key: 'a', value: 1 });
  d('set', { key: 'b', value: 2 });

  // Change max — primary rebuilds the underlying cache while preserving entries.
  assert.equal((d('max', { value: 50 }) as { value: unknown }).value, 50);
  assert.equal((d('get', { key: 'a' }) as { value: unknown }).value, 1);
  assert.equal((d('get', { key: 'b' }) as { value: unknown }).value, 2);
  // Tunables preserved.
  assert.equal((d('ttl') as { value: unknown }).value, 1000);
  assert.equal((d('allowStale') as { value: unknown }).value, true);
});

void test('handleRequest max setter preserves per-entry remaining TTL', async () => {
  caches.clear();
  stats.clear();
  const ns = 'rebuild-ttl';
  const d = (op: string, extra: object = {}) =>
    handleRequest({ id: 'r', namespace: ns, source: SOURCE, op, ...extra } as Request);

  d('init', { options: { max: 10 } });
  d('set', { key: 'k', value: 'v', ttl: 50 });
  await new Promise((r) => setTimeout(r, 20));
  const before = (d('getRemainingTTL', { key: 'k' }) as { value: number }).value;

  d('max', { value: 20 });
  const after = (d('getRemainingTTL', { key: 'k' }) as { value: number }).value;

  assert.ok(before > 0);
  assert.ok(after > 0, `expected positive ttl after rebuild, got ${after}`);
  assert.ok(after <= before, `expected ttl to keep ticking down (${after} <= ${before})`);
});

void test('handleRequest max setter preserves all SerializableLruOptions', () => {
  caches.clear();
  const ns = 'rebuild-tunables';
  const d = (op: string, extra: object = {}) =>
    handleRequest({ id: 'r', namespace: ns, source: SOURCE, op, ...extra } as Request);

  d('init', {
    options: {
      max: 10,
      maxSize: 100,
      maxEntrySize: 50,
      ttl: 1000,
      allowStale: true,
      updateAgeOnGet: true,
      updateAgeOnHas: true,
      noDeleteOnStaleGet: true,
      ttlAutopurge: true,
    },
  });
  d('set', { key: 'a', value: 1, size: 1 });
  d('max', { value: 50 });

  // All fields should survive the rebuild — read straight off the underlying cache.
  const cache = caches.get(ns) as unknown as {
    max: number;
    maxSize: number;
    maxEntrySize: number;
    ttl: number;
    allowStale: boolean;
    updateAgeOnGet: boolean;
    updateAgeOnHas: boolean;
    noDeleteOnStaleGet: boolean;
    ttlAutopurge: boolean;
  };
  assert.equal(cache.max, 50);
  assert.equal(cache.maxSize, 100);
  assert.equal(cache.maxEntrySize, 50);
  assert.equal(cache.ttl, 1000);
  assert.equal(cache.allowStale, true);
  assert.equal(cache.updateAgeOnGet, true);
  assert.equal(cache.updateAgeOnHas, true);
  assert.equal(cache.noDeleteOnStaleGet, true);
  assert.equal(cache.ttlAutopurge, true);
});

void test('handleRequest max setter preserves LRU order (MRU stays MRU)', () => {
  caches.clear();
  const ns = 'rebuild-order';
  const d = (op: string, extra: object = {}) =>
    handleRequest({ id: 'r', namespace: ns, source: SOURCE, op, ...extra } as Request);

  d('init', { options: { max: 10 } });
  // Insertion order: 'lru' first → 'mru' last. After this, 'mru' is most recent.
  d('set', { key: 'lru', value: 1 });
  d('set', { key: 'mru', value: 2 });

  // Shrink to size 1 — under correct LRU semantics, 'lru' (least recent) is
  // evicted and 'mru' survives. The pre-fix bug reversed this.
  d('max', { value: 1 });
  const survivor = (d('keys') as { value: unknown[] }).value;
  assert.deepEqual(survivor, ['mru']);
  assert.equal((d('get', { key: 'mru' }) as { value: unknown }).value, 2);
  assert.equal((d('get', { key: 'lru' }) as { value: unknown }).value, undefined);
});

void test('handleRequest op=getRemainingTTL returns a positive ttl when set', () => {
  caches.clear();
  stats.clear();
  const ns = 'rttl';
  const d = (op: string, extra: object = {}) =>
    handleRequest({ id: 'r', namespace: ns, source: SOURCE, op, ...extra } as Request);

  d('init', { options: { max: 10 } });
  d('set', { key: 'k', value: 'v', ttl: 60_000 });
  const remaining = (d('getRemainingTTL', { key: 'k' }) as { value: unknown }).value;
  assert.equal(typeof remaining, 'number');
  assert.ok((remaining as number) > 0 && (remaining as number) <= 60_000);

  // Missing keys: lru-cache returns 0 (or Infinity if no ttl is set on the cache).
  const missing = (d('getRemainingTTL', { key: 'nope' }) as { value: unknown }).value;
  assert.equal(typeof missing, 'number');
});

void test('handleRequest op=setIfAbsent sets when key absent, no-op when present', () => {
  caches.clear();
  stats.clear();
  const ns = 'sia';
  const d = (op: string, extra: object = {}) =>
    handleRequest({ id: 'r', namespace: ns, source: SOURCE, op, ...extra } as Request);

  d('init', { options: { max: 10 } });

  assert.equal((d('setIfAbsent', { key: 'k', value: 'first' }) as { value: unknown }).value, true);
  assert.equal((d('get', { key: 'k' }) as { value: unknown }).value, 'first');

  // Second call should NOT overwrite and should return false.
  assert.equal((d('setIfAbsent', { key: 'k', value: 'second' }) as { value: unknown }).value, false);
  assert.equal((d('get', { key: 'k' }) as { value: unknown }).value, 'first');
});

void test('handleRequest op=setIfAbsent honors optional ttl', () => {
  caches.clear();
  stats.clear();
  const ns = 'sia-ttl';
  const d = (op: string, extra: object = {}) =>
    handleRequest({ id: 'r', namespace: ns, source: SOURCE, op, ...extra } as Request);

  d('init', { options: { max: 10 } });
  assert.equal((d('setIfAbsent', { key: 'k', value: 'v', ttl: 30_000 }) as { value: unknown }).value, true);
  const remaining = (d('getRemainingTTL', { key: 'k' }) as { value: unknown }).value;
  assert.equal(typeof remaining, 'number');
  assert.ok((remaining as number) > 0 && (remaining as number) <= 30_000);
});

void test('handleRequest op=load restores entries from a dump', () => {
  caches.clear();
  stats.clear();
  const srcNs = 'load-src';
  const dstNs = 'load-dst';
  const dispatch = (ns: string, op: string, extra: object = {}) =>
    handleRequest({ id: 'r', namespace: ns, source: SOURCE, op, ...extra } as Request);

  dispatch(srcNs, 'init', { options: { max: 10 } });
  dispatch(srcNs, 'mSet', {
    entries: [
      ['a', 1],
      ['b', 2],
    ],
  });
  const dump = (dispatch(srcNs, 'dump') as { value: unknown }).value as Array<[unknown, unknown]>;
  assert.ok(Array.isArray(dump));

  dispatch(dstNs, 'init', { options: { max: 10 } });
  const r = dispatch(dstNs, 'load', { entries: dump });
  assert.equal(r.ok, true);
  assert.equal((r as { value: unknown }).value, undefined);

  assert.equal((dispatch(dstNs, 'get', { key: 'a' }) as { value: unknown }).value, 1);
  assert.equal((dispatch(dstNs, 'get', { key: 'b' }) as { value: unknown }).value, 2);
});

void test('handleRequest destroy removes cache, stats, and fetch locks', () => {
  caches.clear();
  stats.clear();
  const ns = 'destroy-ns';
  const d = (op: string, extra: object = {}) =>
    handleRequest({ id: 'r', namespace: ns, source: SOURCE, op, ...extra } as Request);

  d('init', { options: { max: 10 } });
  d('set', { key: 'a', value: 1 });
  const claim = (d('fetchClaim', { key: 'k' }) as { value: { kind: string; token?: string } }).value;
  assert.equal(claim.kind, 'leader');
  assert.equal((d('destroy') as { value: unknown }).value, true);
  assert.equal(caches.has(ns), false);
  assert.equal(stats.has(ns), false);
});

void test('handleRequest destroy reports whether any namespace state existed', () => {
  caches.clear();
  stats.clear();
  const missing = handleRequest({ id: 'd1', namespace: 'destroy-missing', source: SOURCE, op: 'destroy' });
  assert.equal((missing as { value: unknown }).value, false);

  stats.set('destroy-stats-only', {
    namespace: 'destroy-stats-only',
    hits: 0,
    misses: 0,
    sets: 0,
    deletes: 0,
    evictions: 0,
    size: 0,
  });
  const statsOnly = handleRequest({ id: 'd2', namespace: 'destroy-stats-only', source: SOURCE, op: 'destroy' });
  assert.equal((statsOnly as { value: unknown }).value, true);
});

void test('handleRequest fetchAbort returns false for missing or mismatched locks', () => {
  caches.clear();
  stats.clear();
  const ns = 'abort-mismatch';
  const d = (op: string, extra: object = {}) =>
    handleRequest({ id: 'r', namespace: ns, source: SOURCE, cacheOptions: { max: 10 }, op, ...extra } as Request);

  const missing = d('fetchAbort', { key: 'k', token: 'missing' });
  assert.equal((missing as { value: unknown }).value, false);

  const claim = (d('fetchClaim', { key: 'k' }) as { value: { kind: string; token?: string } }).value;
  assert.equal(claim.kind, 'leader');
  const mismatched = d('fetchAbort', { key: 'k', token: 'wrong' });
  assert.equal((mismatched as { value: unknown }).value, false);
  const matched = d('fetchAbort', { key: 'k', token: claim.token });
  assert.equal((matched as { value: unknown }).value, true);
});

void test('handleRequest op=incr with ttl sets ttl only on first write', async () => {
  caches.clear();
  stats.clear();
  const ns = 'incr-ttl';
  const d = (op: string, extra: object = {}) =>
    handleRequest({ id: 'r', namespace: ns, source: SOURCE, op, ...extra } as Request);

  d('init', { options: { max: 10 } });

  // First incr creates the key with ttl=60_000.
  assert.equal((d('incr', { key: 'rl', ttl: 60_000 }) as { value: unknown }).value, 1);
  const firstRemaining = (d('getRemainingTTL', { key: 'rl' }) as { value: unknown }).value as number;
  assert.ok(firstRemaining > 0 && firstRemaining <= 60_000);

  // Wait a brief moment so the remaining TTL would visibly decrease if reset.
  await new Promise((resolve) => setTimeout(resolve, 25));

  // Second incr WITHOUT ttl must NOT reset the TTL — the existing entry's
  // expiration should continue ticking down.
  assert.equal((d('incr', { key: 'rl' }) as { value: unknown }).value, 2);
  const secondRemaining = (d('getRemainingTTL', { key: 'rl' }) as { value: unknown }).value as number;
  assert.ok(secondRemaining > 0);
  assert.ok(secondRemaining <= firstRemaining, `expected ${secondRemaining} <= ${firstRemaining}`);

  // Third incr WITH a fresh ttl should also NOT reset (key already existed).
  assert.equal((d('incr', { key: 'rl', ttl: 60_000 }) as { value: unknown }).value, 3);
  const thirdRemaining = (d('getRemainingTTL', { key: 'rl' }) as { value: unknown }).value as number;
  assert.ok(thirdRemaining <= firstRemaining, `expected ${thirdRemaining} <= ${firstRemaining}`);
});

void test('handleRequest op=decr with ttl sets ttl only on first write', () => {
  caches.clear();
  stats.clear();
  const ns = 'decr-ttl';
  const d = (op: string, extra: object = {}) =>
    handleRequest({ id: 'r', namespace: ns, source: SOURCE, op, ...extra } as Request);

  d('init', { options: { max: 10 } });
  assert.equal((d('decr', { key: 'd', ttl: 45_000 }) as { value: unknown }).value, -1);
  const remaining = (d('getRemainingTTL', { key: 'd' }) as { value: unknown }).value as number;
  assert.ok(remaining > 0 && remaining <= 45_000);
});

void test('handleRequest fetch single-flight coordinates leader, follower, and forceRefresh', () => {
  caches.clear();
  stats.clear();
  const ns = 'fetch-claim';
  const d = (op: string, extra: object = {}) =>
    handleRequest({ id: 'r', namespace: ns, source: SOURCE, op, ...extra } as Request);

  d('init', { options: { max: 10 } });

  const leader = (d('fetchClaim', { key: 'k' }) as { value: { kind: string; token?: string } }).value;
  assert.equal(leader.kind, 'leader');
  const follower = (d('fetchClaim', { key: 'k' }) as { value: { kind: string } }).value;
  assert.equal(follower.kind, 'follower');
  assert.equal((d('fetchStore', { key: 'k', token: leader.token, value: 'v' }) as { value: unknown }).value, true);
  assert.equal((d('get', { key: 'k' }) as { value: unknown }).value, 'v');

  const refreshA = (d('fetchClaim', { key: 'k', forceRefresh: true }) as { value: { kind: string; token?: string } })
    .value;
  const refreshB = (d('fetchClaim', { key: 'k', forceRefresh: true }) as { value: { kind: string; token?: string } })
    .value;
  assert.equal(refreshA.kind, 'leader');
  assert.equal(refreshB.kind, 'leader');
  assert.equal(
    (d('fetchStore', { key: 'k', token: refreshA.token, value: 'stale' }) as { value: unknown }).value,
    false,
  );
  assert.equal(
    (d('fetchStore', { key: 'k', token: refreshB.token, value: 'fresh' }) as { value: unknown }).value,
    true,
  );
  assert.equal((d('get', { key: 'k' }) as { value: unknown }).value, 'fresh');
});

void test('fetchClaim expires a stale leader lock and grants leadership to a follower', () => {
  caches.clear();
  stats.clear();
  const ns = 'fetch-lease';
  const d = (op: string, extra: object = {}) =>
    handleRequest({ id: 'r', namespace: ns, source: SOURCE, op, ...extra } as Request);

  d('init', { options: { max: 10 } });

  const realNow = Date.now;
  let mockTime = realNow();
  Date.now = () => mockTime;

  try {
    const leader1 = (d('fetchClaim', { key: 'k' }) as { value: { kind: string; token?: string } }).value;
    assert.equal(leader1.kind, 'leader');

    // Within the lease window, a second caller is still a follower.
    mockTime += 1_000;
    const followerWhileFresh = (d('fetchClaim', { key: 'k' }) as { value: { kind: string } }).value;
    assert.equal(followerWhileFresh.kind, 'follower');

    // Past the lease window, the stale lock is treated as released and the
    // next caller takes leadership. This unblocks followers when a leader
    // hangs without process exit.
    mockTime += 60_000;
    const leader2 = (d('fetchClaim', { key: 'k' }) as { value: { kind: string; token?: string } }).value;
    assert.equal(leader2.kind, 'leader');
    assert.notEqual(leader1.token, leader2.token);

    // The original leader's fetchStore is rejected because its token no
    // longer matches the active lock.
    assert.equal(
      (d('fetchStore', { key: 'k', token: leader1.token, value: 'stale' }) as { value: unknown }).value,
      false,
    );
    assert.equal(
      (d('fetchStore', { key: 'k', token: leader2.token, value: 'fresh' }) as { value: unknown }).value,
      true,
    );
  } finally {
    Date.now = realNow;
  }
});

void test('handleRequest op=stats returns counters after get/set/delete', () => {
  caches.clear();
  stats.clear();
  const ns = 'stats-basic';
  const d = (op: string, extra: object = {}) =>
    handleRequest({ id: 'r', namespace: ns, source: SOURCE, op, ...extra } as Request);

  d('init', { options: { max: 10 } });
  d('set', { key: 'a', value: 1 });
  d('set', { key: 'b', value: 2 });
  d('get', { key: 'a' });
  d('get', { key: 'a' });
  d('get', { key: 'missing' });
  d('delete', { key: 'a' });
  d('delete', { key: 'still-missing' }); // not counted; returned false

  const s = (d('stats') as { value: unknown }).value as Stats;
  assert.equal(s.namespace, ns);
  assert.equal(s.sets, 2);
  assert.equal(s.hits, 2);
  assert.equal(s.misses, 1);
  assert.equal(s.deletes, 1);
  assert.equal(s.evictions, 0);
  assert.equal(s.size, 1);
});

void test('handleRequest op=stats returns a fresh object, not the live ref', () => {
  caches.clear();
  stats.clear();
  const ns = 'stats-snapshot';
  const d = (op: string, extra: object = {}) =>
    handleRequest({ id: 'r', namespace: ns, source: SOURCE, op, ...extra } as Request);

  d('init', { options: { max: 10 } });
  d('set', { key: 'a', value: 1 });

  const snapshot = (d('stats') as { value: unknown }).value as Stats;
  assert.equal(snapshot.sets, 1);

  // Mutating the snapshot must not affect future reads.
  snapshot.sets = 9999;
  const fresh = (d('stats') as { value: unknown }).value as Stats;
  assert.equal(fresh.sets, 1);
});

void test('handleRequest stats counts evictions when capacity is exceeded', () => {
  caches.clear();
  stats.clear();
  const ns = 'evict';
  const d = (op: string, extra: object = {}) =>
    handleRequest({ id: 'r', namespace: ns, source: SOURCE, op, ...extra } as Request);

  d('init', { options: { max: 2 } });
  d('set', { key: 'a', value: 1 });
  d('set', { key: 'b', value: 2 });
  d('set', { key: 'c', value: 3 }); // forces eviction of 'a'

  const s = (d('stats') as { value: unknown }).value as Stats;
  assert.equal(s.evictions, 1);
  assert.equal(s.sets, 3);
  assert.equal(s.size, 2);
});

void test('handleRequest clear does not increment deletes', () => {
  caches.clear();
  stats.clear();
  const ns = 'clear-stats';
  const d = (op: string, extra: object = {}) =>
    handleRequest({ id: 'r', namespace: ns, source: SOURCE, op, ...extra } as Request);

  d('init', { options: { max: 10 } });
  d('mSet', {
    entries: [
      ['a', 1],
      ['b', 2],
    ],
  });
  d('clear');
  const s = (d('stats') as { value: unknown }).value as Stats;
  assert.equal(s.deletes, 0);
  assert.equal(s.sets, 2);
  assert.equal(s.size, 0);
});

void test('handleRequest mDelete only counts keys actually deleted', () => {
  caches.clear();
  stats.clear();
  const ns = 'mdelete-stats';
  const d = (op: string, extra: object = {}) =>
    handleRequest({ id: 'r', namespace: ns, source: SOURCE, op, ...extra } as Request);

  d('init', { options: { max: 10 } });
  d('set', { key: 'a', value: 1 });
  d('mDelete', { keys: ['a', 'missing-1', 'missing-2'] });
  const s = (d('stats') as { value: unknown }).value as Stats;
  assert.equal(s.deletes, 1);
});

void test('handleRequest setIfAbsent only counts sets when actually set', () => {
  caches.clear();
  stats.clear();
  const ns = 'sia-stats';
  const d = (op: string, extra: object = {}) =>
    handleRequest({ id: 'r', namespace: ns, source: SOURCE, op, ...extra } as Request);

  d('init', { options: { max: 10 } });
  d('setIfAbsent', { key: 'k', value: 'v' }); // sets++
  d('setIfAbsent', { key: 'k', value: 'v2' }); // no-op
  d('setIfAbsent', { key: 'k', value: 'v3' }); // no-op
  const s = (d('stats') as { value: unknown }).value as Stats;
  assert.equal(s.sets, 1);
});

void test('handleRequest incr/decr count as sets in stats', () => {
  caches.clear();
  stats.clear();
  const ns = 'incr-stats';
  const d = (op: string, extra: object = {}) =>
    handleRequest({ id: 'r', namespace: ns, source: SOURCE, op, ...extra } as Request);

  d('init', { options: { max: 10 } });
  d('incr', { key: 'c' });
  d('incr', { key: 'c' });
  d('decr', { key: 'c' });
  const s = (d('stats') as { value: unknown }).value as Stats;
  assert.equal(s.sets, 3);
});

void test('handleRequest rejects non-object input with empty id and structured error', () => {
  const r1 = handleRequest('not an object' as unknown as Request);
  assert.equal(r1.ok, false);
  assert.equal(r1.id, '');
  assert.match((r1 as { error: { message: string } }).error.message, /not an object/);

  const r2 = handleRequest(null as unknown as Request);
  assert.equal(r2.ok, false);
  assert.equal(r2.id, '');
});

void test('getStats recreates the stats record if it has been removed', () => {
  caches.clear();
  stats.clear();
  // Init creates both the cache and its stats record.
  handleRequest({ id: 'i', namespace: 'gs', source: SOURCE, op: 'init', options: { max: 5 } });
  // Externally remove the stats record while the cache stays around.
  stats.delete('gs');
  // A subsequent op (set) calls getStats, which should recreate the record.
  const r = handleRequest({ id: 's', namespace: 'gs', source: SOURCE, op: 'set', key: 'k', value: 'v' });
  assert.equal(r.ok, true);
  const recreated = stats.get('gs');
  assert.ok(recreated);
  assert.equal(recreated.namespace, 'gs');
  assert.equal(recreated.sets, 1);
});

void test('serializeError captures Error code and chained cause', () => {
  const inner = new Error('inner-msg');
  (inner as { code?: string }).code = 'E_INNER';
  const outer = new Error('outer-msg');
  (outer as { code?: string }).code = 'E_OUTER';
  (outer as { cause?: unknown }).cause = inner;
  const s = serializeError(outer);
  assert.equal(s.name, 'Error');
  assert.equal(s.message, 'outer-msg');
  assert.equal(s.code, 'E_OUTER');
  assert.ok(s.cause);
  assert.equal(s.cause.message, 'inner-msg');
  assert.equal(s.cause.code, 'E_INNER');
});

void test('serializeError accepts numeric code', () => {
  const e = new Error('numeric');
  (e as { code?: number }).code = 42;
  assert.equal(serializeError(e).code, 42);
});

void test('serializeError handles Error without stack', () => {
  const e = new Error('no-stack');
  (e as { stack?: undefined }).stack = undefined;
  const s = serializeError(e);
  assert.equal(s.message, 'no-stack');
  assert.equal(s.stack, undefined);
});

void test('serializeError wraps non-Error throws', () => {
  assert.deepEqual(serializeError('plain string'), { name: 'Error', message: 'plain string' });
  assert.deepEqual(serializeError(42), { name: 'Error', message: '42' });
  assert.deepEqual(serializeError({ foo: 1 }), { name: 'Error', message: '[object Object]' });
});

void test('setIfAbsent does not refresh TTL via updateAgeOnHas on existing key', async () => {
  caches.clear();
  stats.clear();
  const ns = 'sia-no-age-update';
  const d = (op: string, extra: object = {}) =>
    handleRequest({ id: 'r', namespace: ns, source: SOURCE, op, ...extra } as Request);

  d('init', { options: { max: 5, updateAgeOnHas: true, updateAgeOnGet: true } });
  d('set', { key: 'k', value: 'v0', ttl: 10_000 });

  // Let real time advance enough that a refreshed age would be obviously
  // distinguishable from the original (~10000 vs ~9950).
  await new Promise((r) => setTimeout(r, 50));

  const result = (d('setIfAbsent', { key: 'k', value: 'v1' }) as { value: unknown }).value;
  assert.equal(result, false, 'existing key should reject the write');

  const ttlAfter = (d('getRemainingTTL', { key: 'k' }) as { value: number }).value;
  assert.ok(ttlAfter < 10_000, `expected ttl to have decreased from initial 10_000, got ${ttlAfter}`);
  assert.ok(ttlAfter >= 9_900, `expected ttl to remain near 9_950 (no refresh), got ${ttlAfter}`);
});

void test('incr does not refresh TTL via updateAgeOnHas/updateAgeOnGet on existing counter', async () => {
  caches.clear();
  stats.clear();
  const ns = 'incr-no-age-update';
  const d = (op: string, extra: object = {}) =>
    handleRequest({ id: 'r', namespace: ns, source: SOURCE, op, ...extra } as Request);

  d('init', { options: { max: 5, updateAgeOnHas: true, updateAgeOnGet: true } });
  d('set', { key: 'k', value: 0, ttl: 10_000 });

  // Sleep enough that a refreshed age would push ttl back to the original.
  await new Promise((r) => setTimeout(r, 50));

  const next = (d('incr', { key: 'k' }) as { value: unknown }).value;
  assert.equal(next, 1);

  const ttlAfter = (d('getRemainingTTL', { key: 'k' }) as { value: number }).value;
  assert.ok(ttlAfter < 10_000, `expected ttl to have decreased from initial 10_000, got ${ttlAfter}`);
  assert.ok(ttlAfter >= 9_900, `expected ttl to remain near 9_950 (no refresh), got ${ttlAfter}`);
});

void test('serializeError detects self-referential cause cycles', () => {
  const e = new Error('loop') as Error & { cause?: unknown };
  e.cause = e;
  // Without cycle detection this would recurse forever and stack-overflow.
  const s = serializeError(e);
  assert.equal(s.message, 'loop');
  assert.equal((s.cause as { message?: string } | undefined)?.message, '[circular cause]');
});

void test('serializeError truncates very deep cause chains', () => {
  let leaf: Error & { cause?: unknown } = new Error('leaf');
  // Build a chain longer than SERIALIZE_CAUSE_MAX_DEPTH (8).
  for (let i = 0; i < 20; i++) {
    const wrapper: Error & { cause?: unknown } = new Error(`level-${i}`);
    wrapper.cause = leaf;
    leaf = wrapper;
  }
  const s = serializeError(leaf);
  // Walk down the cause chain and confirm a truncation marker appears.
  let cur: { message?: string; cause?: unknown } | undefined = s;
  let truncated = false;
  while (cur) {
    if (cur.message === '[cause chain truncated]') {
      truncated = true;
      break;
    }
    cur = cur.cause as { message?: string; cause?: unknown } | undefined;
  }
  assert.equal(truncated, true, 'expected a truncation marker somewhere in the cause chain');
});

void test('deserializeError round-trips through serialize', () => {
  const original = new Error('round-trip');
  original.name = 'CustomErr';
  (original as { code?: string }).code = 'E_RT';
  (original as { cause?: unknown }).cause = new Error('the-cause');
  const reconstructed = deserializeError(serializeError(original));
  assert.equal(reconstructed.name, 'CustomErr');
  assert.equal(reconstructed.message, 'round-trip');
  assert.equal((reconstructed as { code?: unknown }).code, 'E_RT');
  const cause = (reconstructed as { cause?: Error }).cause;
  assert.ok(cause instanceof Error);
  assert.equal(cause.message, 'the-cause');
});
