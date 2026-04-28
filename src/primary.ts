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

// Casts an `unknown` IPC payload to the non-nullish bound that lru-cache@11
// requires. The runtime already guards against null/undefined keys via
// LRUCache's own checks; this is purely a TS-type bridge.
const k = (v: unknown): NonNullish => v as NonNullish;

export const caches: Map<string, AnyCache> = new Map();
export const stats: Map<string, Stats> = new Map();

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
    ttl: number;
    allowStale: boolean;
    updateAgeOnGet: boolean;
    updateAgeOnHas: boolean;
    noDeleteOnStaleGet: boolean;
    ttlAutopurge: boolean;
  };
  return {
    max: c.max,
    ttl: c.ttl,
    allowStale: c.allowStale,
    updateAgeOnGet: c.updateAgeOnGet,
    updateAgeOnHas: c.updateAgeOnHas,
    noDeleteOnStaleGet: c.noDeleteOnStaleGet,
    ttlAutopurge: c.ttlAutopurge,
  };
}

function buildCache(options: SerializableLruOptions, s: Stats): AnyCache {
  return new LRUCache({
    max: 1000,
    ...options,
    dispose: (_value: NonNullish, _key: NonNullish, reason: LRUCache.DisposeReason) => {
      if (reason === 'evict') s.evictions += 1;
    },
  });
}

export function getOrCreateCache(namespace: string, options?: SerializableLruOptions): AnyCache {
  let cache = caches.get(namespace);
  if (!cache) {
    const s = freshStats(namespace);
    stats.set(namespace, s);
    cache = buildCache(options ?? {}, s);
    caches.set(namespace, cache);
    debug(`Created LRUCache for namespace '${namespace}'`);
  }
  return cache;
}

// Pure dispatch: returns the value for the op or throws. Single source of truth
// for op semantics; both `handleRequest` (IPC entry point) and the in-process
// primary fast-path in `index.ts` call this. Avoids object/promise allocation
// per call when no IPC is involved.
export function dispatchOp(namespace: string, payload: ExecPayload): unknown {
  switch (payload.op) {
    case 'init': {
      const isNew = !caches.has(namespace);
      const cache = getOrCreateCache(namespace, payload.options);
      return { namespace, isNew, max: cache.max };
    }
    case 'get': {
      const cache = getOrCreateCache(namespace);
      const value = cache.get(k(payload.key));
      const s = getStats(namespace);
      if (value !== undefined) s.hits += 1;
      else s.misses += 1;
      return value;
    }
    case 'set': {
      const cache = getOrCreateCache(namespace);
      cache.set(k(payload.key), k(payload.value), payload.ttl ? { ttl: payload.ttl } : undefined);
      getStats(namespace).sets += 1;
      return true;
    }
    case 'setIfAbsent': {
      const cache = getOrCreateCache(namespace);
      if (cache.has(k(payload.key))) return false;
      cache.set(k(payload.key), k(payload.value), payload.ttl ? { ttl: payload.ttl } : undefined);
      getStats(namespace).sets += 1;
      return true;
    }
    case 'delete': {
      const cache = getOrCreateCache(namespace);
      const deleted = cache.delete(k(payload.key));
      if (deleted) getStats(namespace).deletes += 1;
      return deleted;
    }
    case 'has':
      return getOrCreateCache(namespace).has(k(payload.key));
    case 'peek':
      return getOrCreateCache(namespace).peek(k(payload.key));
    case 'getRemainingTTL':
      return getOrCreateCache(namespace).getRemainingTTL(k(payload.key));
    case 'clear':
      getOrCreateCache(namespace).clear();
      return undefined;
    case 'mGet': {
      const cache = getOrCreateCache(namespace);
      const s = getStats(namespace);
      return payload.keys.map((key) => {
        const value = cache.get(k(key));
        if (value !== undefined) s.hits += 1;
        else s.misses += 1;
        return [key, value] as [unknown, unknown];
      });
    }
    case 'mSet': {
      const cache = getOrCreateCache(namespace);
      const setOpts = payload.ttl ? { ttl: payload.ttl } : undefined;
      const s = getStats(namespace);
      for (const [key, value] of payload.entries) {
        cache.set(k(key), k(value), setOpts);
        s.sets += 1;
      }
      return undefined;
    }
    case 'mDelete': {
      const cache = getOrCreateCache(namespace);
      const s = getStats(namespace);
      for (const key of payload.keys) {
        if (cache.delete(k(key))) s.deletes += 1;
      }
      return undefined;
    }
    case 'keys':
      return [...getOrCreateCache(namespace).keys()];
    case 'values':
      return [...getOrCreateCache(namespace).values()];
    case 'entries':
      return [...getOrCreateCache(namespace).entries()];
    case 'dump':
      return getOrCreateCache(namespace).dump();
    case 'load': {
      const cache = getOrCreateCache(namespace);
      cache.load(payload.entries as Array<[NonNullish, LRUCache.Entry<NonNullish>]>);
      return undefined;
    }
    case 'size':
      return getOrCreateCache(namespace).size;
    case 'stats': {
      const cache = getOrCreateCache(namespace);
      const s = getStats(namespace);
      s.size = cache.size;
      return { ...s };
    }
    case 'purgeStale':
      return getOrCreateCache(namespace).purgeStale();
    case 'incr':
    case 'decr': {
      const cache = getOrCreateCache(namespace);
      const existed = cache.has(k(payload.key));
      const current = cache.get(k(payload.key));
      const base = typeof current === 'number' ? current : 0;
      const delta = (payload.amount ?? 1) * (payload.op === 'decr' ? -1 : 1);
      const next = base + delta;
      // Rate-limiter semantics: ttl on first write only. For pre-existing
      // keys, noUpdateTTL keeps the original expiration ticking — without
      // it, `cache.set(k, v)` would reset to the cache's default ttl (or
      // strip it entirely if the cache has none).
      const setOpts: { ttl?: number; noUpdateTTL?: boolean } | undefined = existed
        ? { noUpdateTTL: true }
        : payload.ttl
          ? { ttl: payload.ttl }
          : undefined;
      cache.set(k(payload.key), next, setOpts);
      getStats(namespace).sets += 1;
      return next;
    }
    case 'max': {
      const cache = getOrCreateCache(namespace);
      if (typeof payload.value === 'number' && payload.value !== cache.max) {
        // lru-cache@11 has no setter for max — rebuild. Two correctness points:
        // (1) preserve every SerializableLruOptions field, not just ttl and
        //     allowStale, so updateAgeOnGet/updateAgeOnHas/etc. survive;
        // (2) replay entries in LRU-first order so the originally-MRU stays
        //     MRU after the rebuild — `cache.entries()` yields MRU-first, so
        //     reverse it before re-setting.
        // Reuse the existing stats record so the new dispose hook keeps
        // counting evictions for the same namespace.
        const s = getStats(namespace);
        const opts = { ...readOptions(cache), max: payload.value };
        const replacement = buildCache(opts, s);
        const ordered = [...cache.entries()].reverse();
        for (const [key, value] of ordered) replacement.set(key, value);
        caches.set(namespace, replacement);
        return replacement.max;
      }
      return cache.max;
    }
    case 'ttl': {
      const cache = getOrCreateCache(namespace);
      if (typeof payload.value === 'number') (cache as unknown as { ttl: number }).ttl = payload.value;
      return (cache as unknown as { ttl: number }).ttl;
    }
    case 'allowStale': {
      const cache = getOrCreateCache(namespace);
      if (typeof payload.value === 'boolean') (cache as unknown as { allowStale: boolean }).allowStale = payload.value;
      return (cache as unknown as { allowStale: boolean }).allowStale;
    }
    default: {
      const op = (payload as { op: string }).op;
      throw new Error(`unhandled op: ${op}`);
    }
  }
}

export function handleRequest(request: Request): Response {
  if (typeof request !== 'object' || request === null) {
    return err(request, 'invalid request: not an object');
  }
  try {
    return ok(request, dispatchOp(request.namespace, request));
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
  cluster.on('fork', (worker: Worker) => {
    worker.on('message', (raw: unknown) => {
      if (!isOurRequest(raw)) return;
      messagesDebug(`primary <- worker ${worker.id}`, raw);
      const response = handleRequest(raw);
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
