import cluster from 'node:cluster';
import type { Worker } from 'node:cluster';
import Debug from 'debug';
import { LRUCache } from 'lru-cache';
import {
  DEBUG_PREFIX,
  SOURCE,
  serializeError,
  type Request,
  type Response,
  type SerializableLruOptions,
  type Stats,
} from './messages.js';

// Distributive Omit so each member of the Request union keeps its own shape.
type DistributiveOmit<T, K extends keyof never> = T extends unknown ? Omit<T, K> : never;
export type ExecPayload = DistributiveOmit<Request, 'id' | 'namespace' | 'source'>;

const debug = Debug(`${DEBUG_PREFIX}-primary`);
const messagesDebug = Debug(`${DEBUG_PREFIX}-messages`);

// Public registry: namespace -> LRUCache. Keys/values constrained to non-nullish
// per lru-cache@11 signature; we operate on `unknown` at the IPC boundary and
// trust the runtime to filter undefined/null inputs.
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
type NonNullish = {};
type AnyCache = LRUCache<NonNullish, NonNullish>;

type DispatchContext = {
  workerId?: number;
};

type FetchLock = {
  token: string;
  ownerWorkerId?: number;
};

type PrimaryState = {
  caches: Map<string, AnyCache>;
  stats: Map<string, Stats>;
  fetchLocks: Map<string, Map<NonNullish, FetchLock>>;
  clusterListenerInstalled: boolean;
  nextFetchToken: number;
};

// The scoped and legacy package names can coexist during the migration window.
// Share primary-side state process-wide so both names use one IPC listener and
// one namespace registry when they are installed together.
const STATE_KEY = Symbol.for('lru-cache-clustered.primary');
const primaryState = ((globalThis as Record<PropertyKey, unknown>)[STATE_KEY] ??= {
  caches: new Map<string, AnyCache>(),
  stats: new Map<string, Stats>(),
  fetchLocks: new Map<string, Map<NonNullish, FetchLock>>(),
  clusterListenerInstalled: false,
  nextFetchToken: 0,
}) as PrimaryState;

export const caches = primaryState.caches;
export const stats = primaryState.stats;
const fetchLocks = primaryState.fetchLocks;

function freshStats(namespace: string): Stats {
  return { namespace, hits: 0, misses: 0, sets: 0, deletes: 0, evictions: 0, size: 0 };
}

function getStats(namespace: string): Stats {
  let s = stats.get(namespace);
  if (!s) {
    s = freshStats(namespace);
    stats.set(namespace, s);
  }
  return s;
}

// Capture the runtime-readable SerializableLruOptions off an existing cache.
// Used by the `max` rebuild so the new instance keeps every tunable the old
// one had — not just `ttl` and `allowStale`. lru-cache@11 exposes these as
// instance properties; we go through `as unknown as ...` rather than typing
// the full LRUCache interface here.
function readOptions(cache: AnyCache): SerializableLruOptions {
  const c = cache as unknown as {
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
  return {
    max: c.max,
    maxSize: c.maxSize,
    maxEntrySize: c.maxEntrySize,
    ttl: c.ttl,
    allowStale: c.allowStale,
    updateAgeOnGet: c.updateAgeOnGet,
    updateAgeOnHas: c.updateAgeOnHas,
    noDeleteOnStaleGet: c.noDeleteOnStaleGet,
    ttlAutopurge: c.ttlAutopurge,
  };
}

function getCacheForPayload(namespace: string, payload: ExecPayload): AnyCache {
  const existing = caches.get(namespace);
  if (existing) return existing;
  return getOrCreateCache(namespace, payload.cacheOptions);
}

function assertOptionsCompatible(namespace: string, cache: AnyCache, options?: SerializableLruOptions): void {
  if (!options) return;

  const current = readOptions(cache);
  const mismatches: string[] = [];

  for (const [key, value] of Object.entries(options) as Array<
    [keyof SerializableLruOptions, SerializableLruOptions[keyof SerializableLruOptions]]
  >) {
    if (value === undefined) continue;
    if (current[key] !== value) {
      mismatches.push(`${key}=${String(current[key])} (existing) != ${String(value)} (incoming)`);
    }
  }

  if (mismatches.length > 0) {
    throw new Error(`Conflicting options for namespace '${namespace}': ${mismatches.join(', ')}`);
  }
}

function requireNonNullish(label: string, value: unknown): NonNullish {
  if (value === null || value === undefined) {
    throw new TypeError(`${label} must not be null or undefined`);
  }
  return value;
}

function buildSetOptions(opts: { ttl?: number; size?: number; noUpdateTTL?: boolean }):
  | {
      ttl?: number;
      size?: number;
      noUpdateTTL?: boolean;
    }
  | undefined {
  const out: { ttl?: number; size?: number; noUpdateTTL?: boolean } = {};
  if (opts.ttl !== undefined) out.ttl = opts.ttl;
  if (opts.size !== undefined) out.size = opts.size;
  if (opts.noUpdateTTL) out.noUpdateTTL = true;
  return Object.keys(out).length > 0 ? out : undefined;
}

function readEntrySize(cache: AnyCache, key: NonNullish): number | undefined {
  const info = (
    cache as unknown as {
      info: (key: NonNullish) => LRUCache.Entry<NonNullish> | undefined;
    }
  ).info(key);
  return typeof info?.size === 'number' ? info.size : undefined;
}

function getFetchNamespaceLocks(namespace: string): Map<NonNullish, FetchLock> {
  let locks = fetchLocks.get(namespace);
  if (!locks) {
    locks = new Map();
    fetchLocks.set(namespace, locks);
  }
  return locks;
}

function cleanupFetchNamespaceLocks(namespace: string): void {
  if (fetchLocks.get(namespace)?.size === 0) fetchLocks.delete(namespace);
}

function releaseFetchLocksForWorker(workerId: number): void {
  for (const [namespace, locks] of fetchLocks) {
    for (const [key, lock] of locks) {
      if (lock.ownerWorkerId === workerId) {
        locks.delete(key);
      }
    }
    cleanupFetchNamespaceLocks(namespace);
  }
}

function buildCache(options: SerializableLruOptions, s: Stats): AnyCache {
  const cacheOptions = {
    ...options,
    dispose: (_value: NonNullish, _key: NonNullish, reason: LRUCache.DisposeReason) => {
      if (reason === 'evict') s.evictions += 1;
    },
  } as SerializableLruOptions & {
    dispose: (_value: NonNullish, _key: NonNullish, reason: LRUCache.DisposeReason) => void;
  };
  const defaultedOptions =
    cacheOptions.max === undefined && cacheOptions.maxSize === undefined && cacheOptions.ttl === undefined
      ? { ...cacheOptions, max: 1000 }
      : cacheOptions;
  return new LRUCache(defaultedOptions as ConstructorParameters<typeof LRUCache>[0]);
}

export function getOrCreateCache(namespace: string, options?: SerializableLruOptions): AnyCache {
  let cache = caches.get(namespace);
  if (!cache) {
    const s = freshStats(namespace);
    stats.set(namespace, s);
    cache = buildCache(options ?? {}, s);
    caches.set(namespace, cache);
    debug(`Created LRUCache for namespace '${namespace}'`);
  } else {
    assertOptionsCompatible(namespace, cache, options);
  }
  return cache;
}

// Pure dispatch: returns the value for the op or throws. Single source of truth
// for op semantics; both `handleRequest` (IPC entry point) and the in-process
// primary fast-path in `index.ts` call this. Avoids object/promise allocation
// per call when no IPC is involved.
export function dispatchOp(namespace: string, payload: ExecPayload, context: DispatchContext = {}): unknown {
  switch (payload.op) {
    case 'init': {
      const isNew = !caches.has(namespace);
      const cache = getOrCreateCache(namespace, payload.options);
      return { namespace, isNew, max: cache.max };
    }
    case 'healthCheck':
      getOrCreateCache(namespace, payload.cacheOptions);
      return undefined;
    case 'destroy': {
      const cacheExisted = caches.delete(namespace);
      const statsExisted = stats.delete(namespace);
      const locksExisted = fetchLocks.delete(namespace);
      return cacheExisted || statsExisted || locksExisted;
    }
    case 'get': {
      const cache = getCacheForPayload(namespace, payload);
      const value = cache.get(requireNonNullish('cache key', payload.key));
      const s = getStats(namespace);
      if (value !== undefined) s.hits += 1;
      else s.misses += 1;
      return value;
    }
    case 'set': {
      const cache = getCacheForPayload(namespace, payload);
      cache.set(
        requireNonNullish('cache key', payload.key),
        requireNonNullish('cache value', payload.value),
        buildSetOptions({ ttl: payload.ttl, size: payload.size }),
      );
      getStats(namespace).sets += 1;
      return true;
    }
    case 'setIfAbsent': {
      const cache = getCacheForPayload(namespace, payload);
      const key = requireNonNullish('cache key', payload.key);
      if (cache.has(key)) return false;
      cache.set(
        key,
        requireNonNullish('cache value', payload.value),
        buildSetOptions({ ttl: payload.ttl, size: payload.size }),
      );
      getStats(namespace).sets += 1;
      return true;
    }
    case 'delete': {
      const cache = getCacheForPayload(namespace, payload);
      const deleted = cache.delete(requireNonNullish('cache key', payload.key));
      if (deleted) getStats(namespace).deletes += 1;
      return deleted;
    }
    case 'has':
      return getCacheForPayload(namespace, payload).has(requireNonNullish('cache key', payload.key));
    case 'peek':
      return getCacheForPayload(namespace, payload).peek(requireNonNullish('cache key', payload.key));
    case 'getRemainingTTL':
      return getCacheForPayload(namespace, payload).getRemainingTTL(requireNonNullish('cache key', payload.key));
    case 'clear':
      getCacheForPayload(namespace, payload).clear();
      return undefined;
    case 'mGet': {
      const cache = getCacheForPayload(namespace, payload);
      const s = getStats(namespace);
      return payload.keys.map((key) => {
        const value = cache.get(requireNonNullish('cache key', key));
        if (value !== undefined) s.hits += 1;
        else s.misses += 1;
        return [key, value] as [unknown, unknown];
      });
    }
    case 'mSet': {
      const cache = getCacheForPayload(namespace, payload);
      const s = getStats(namespace);
      for (const [key, value, entryOpts] of payload.entries) {
        cache.set(
          requireNonNullish('cache key', key),
          requireNonNullish('cache value', value),
          buildSetOptions({
            ttl: entryOpts?.ttl ?? payload.ttl,
            size: entryOpts?.size ?? payload.size,
          }),
        );
        s.sets += 1;
      }
      return undefined;
    }
    case 'mDelete': {
      const cache = getCacheForPayload(namespace, payload);
      const s = getStats(namespace);
      for (const key of payload.keys) {
        if (cache.delete(requireNonNullish('cache key', key))) s.deletes += 1;
      }
      return undefined;
    }
    case 'keys':
      return [...getCacheForPayload(namespace, payload).keys()];
    case 'values':
      return [...getCacheForPayload(namespace, payload).values()];
    case 'entries':
      return [...getCacheForPayload(namespace, payload).entries()];
    case 'dump':
      return getCacheForPayload(namespace, payload).dump();
    case 'load': {
      const cache = getCacheForPayload(namespace, payload);
      const entries = payload.entries.map(([key, entry]) => {
        const safeKey = requireNonNullish('cache key', key);
        const safeEntry = entry as { value?: unknown };
        requireNonNullish('cache value', safeEntry.value);
        return [safeKey, entry] as [NonNullish, LRUCache.Entry<NonNullish>];
      });
      cache.load(entries);
      return undefined;
    }
    case 'size':
      return getCacheForPayload(namespace, payload).size;
    case 'stats': {
      const cache = getCacheForPayload(namespace, payload);
      const s = getStats(namespace);
      s.size = cache.size;
      return { ...s };
    }
    case 'purgeStale':
      return getCacheForPayload(namespace, payload).purgeStale();
    case 'incr':
    case 'decr': {
      const cache = getCacheForPayload(namespace, payload);
      const key = requireNonNullish('cache key', payload.key);
      const existed = cache.has(key);
      const current = cache.get(key);
      const base = typeof current === 'number' ? current : 0;
      const delta = (payload.amount ?? 1) * (payload.op === 'decr' ? -1 : 1);
      const next = base + delta;
      const size = payload.size ?? (existed ? readEntrySize(cache, key) : undefined);
      // Rate-limiter semantics: ttl on first write only. For pre-existing
      // keys, noUpdateTTL keeps the original expiration ticking — without
      // it, `cache.set(k, v)` would reset to the cache's default ttl (or
      // strip it entirely if the cache has none).
      const setOpts = buildSetOptions(
        existed
          ? { size, noUpdateTTL: true }
          : {
              ttl: payload.ttl,
              size,
            },
      );
      cache.set(key, next, setOpts);
      getStats(namespace).sets += 1;
      return next;
    }
    case 'fetchClaim': {
      const cache = getCacheForPayload(namespace, payload);
      const key = requireNonNullish('cache key', payload.key);
      const locks = getFetchNamespaceLocks(namespace);
      if (!payload.forceRefresh) {
        const value = cache.get(key);
        if (value !== undefined) return { kind: 'value', value };
        if (locks.has(key)) return { kind: 'follower' };
      }
      const token = `fetch-${++primaryState.nextFetchToken}`;
      locks.set(key, { token, ownerWorkerId: context.workerId });
      return { kind: 'leader', token };
    }
    case 'fetchStore': {
      const cache = getCacheForPayload(namespace, payload);
      const key = requireNonNullish('cache key', payload.key);
      const locks = fetchLocks.get(namespace);
      const lock = locks?.get(key);
      if (!lock || lock.token !== payload.token) return false;
      cache.set(
        key,
        requireNonNullish('cache value', payload.value),
        buildSetOptions({ ttl: payload.ttl, size: payload.size }),
      );
      locks?.delete(key);
      cleanupFetchNamespaceLocks(namespace);
      getStats(namespace).sets += 1;
      return true;
    }
    case 'fetchAbort': {
      const key = requireNonNullish('cache key', payload.key);
      const locks = fetchLocks.get(namespace);
      const lock = locks?.get(key);
      if (!lock || lock.token !== payload.token) return false;
      locks?.delete(key);
      cleanupFetchNamespaceLocks(namespace);
      return true;
    }
    case 'max': {
      const cache = getCacheForPayload(namespace, payload);
      if (typeof payload.value === 'number' && payload.value !== cache.max) {
        // lru-cache@11 has no setter for max — rebuild. Two correctness points:
        // (1) preserve every SerializableLruOptions field, not just ttl and
        //     allowStale, so updateAgeOnGet/updateAgeOnHas/etc. survive;
        // (2) preserve per-entry metadata such as remaining TTL. `dump()` /
        //     `load()` keeps entry age data intact; replaying via plain `set()`
        //     would silently refresh or strip expirations.
        // Reuse the existing stats record so the new dispose hook keeps
        // counting evictions for the same namespace.
        const s = getStats(namespace);
        const opts = { ...readOptions(cache), max: payload.value };
        const replacement = buildCache(opts, s);
        replacement.load(cache.dump());
        caches.set(namespace, replacement);
        return replacement.max;
      }
      return cache.max;
    }
    case 'ttl': {
      const cache = getCacheForPayload(namespace, payload);
      if (typeof payload.value === 'number') (cache as unknown as { ttl: number }).ttl = payload.value;
      return (cache as unknown as { ttl: number }).ttl;
    }
    case 'allowStale': {
      const cache = getCacheForPayload(namespace, payload);
      if (typeof payload.value === 'boolean') (cache as unknown as { allowStale: boolean }).allowStale = payload.value;
      return (cache as unknown as { allowStale: boolean }).allowStale;
    }
    default: {
      const op = (payload as { op: string }).op;
      throw new Error(`unhandled op: ${op}`);
    }
  }
}

export function handleRequest(request: Request, context: DispatchContext = {}): Response {
  if (typeof request !== 'object' || request === null) {
    return err(request, 'invalid request: not an object');
  }
  try {
    return ok(request, dispatchOp(request.namespace, request, context));
  } catch (e) {
    return err(request, e);
  }
}

function ok(request: Request, value: unknown): Response {
  return { id: request.id, source: SOURCE, ok: true, value };
}
function err(request: unknown, cause: unknown): Response {
  const id =
    typeof request === 'object' && request !== null && typeof (request as { id?: unknown }).id === 'string'
      ? (request as { id: string }).id
      : '';
  return { id, source: SOURCE, ok: false, error: serializeError(cause) };
}

// Caller must check `cluster.isPrimary` — this only runs on the primary.
export function installClusterListener(): void {
  if (primaryState.clusterListenerInstalled) return;
  primaryState.clusterListenerInstalled = true;

  cluster.on('exit', (worker: Worker) => {
    releaseFetchLocksForWorker(worker.id);
  });
  cluster.on('fork', (worker: Worker) => {
    worker.on('message', (raw: unknown) => {
      if (!isOurRequest(raw)) return;
      messagesDebug(`primary <- worker ${worker.id}`, raw);
      const response = handleRequest(raw, { workerId: worker.id });
      worker.send(response);
    });
  });
}

function isOurRequest(value: unknown): value is Request {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { source?: unknown }).source === SOURCE &&
    typeof (value as { id?: unknown }).id === 'string' &&
    typeof (value as { op?: unknown }).op === 'string'
  );
}
