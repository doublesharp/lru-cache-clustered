import cluster from 'node:cluster';
import type { Worker } from 'node:cluster';
import Debug from 'debug';
import { LRUCache } from 'lru-cache';
import {
  SOURCE,
  serializeError,
  type Request,
  type Response,
  type SerializableLruOptions,
  type Stats,
} from './messages.js';

const debug = Debug(`${SOURCE}-primary`);
const messagesDebug = Debug(`${SOURCE}-messages`);

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

export function getOrCreateCache(namespace: string, options: SerializableLruOptions): AnyCache {
  let cache = caches.get(namespace);
  if (!cache) {
    const s = freshStats(namespace);
    stats.set(namespace, s);
    cache = new LRUCache({
      max: 1000,
      ...options,
      dispose: (_value: NonNullish, _key: NonNullish, reason: LRUCache.DisposeReason) => {
        if (reason === 'evict') s.evictions += 1;
      },
    });
    caches.set(namespace, cache);
    debug(`Created LRUCache for namespace '${namespace}'`);
  }
  return cache;
}

export function handleRequest(request: Request): Response {
  if (typeof request !== 'object' || request === null) {
    return err(request, 'invalid request: not an object');
  }
  try {
    switch (request.op) {
      case 'init': {
        const isNew = !caches.has(request.namespace);
        const cache = getOrCreateCache(request.namespace, request.options);
        return ok(request, {
          namespace: request.namespace,
          isNew,
          max: cache.max,
        });
      }
      case 'get': {
        const cache = getOrCreateCache(request.namespace, {});
        const value = cache.get(k(request.key));
        const s = getStats(request.namespace);
        if (value !== undefined) s.hits += 1;
        else s.misses += 1;
        return ok(request, value);
      }
      case 'set': {
        const cache = getOrCreateCache(request.namespace, {});
        cache.set(k(request.key), k(request.value), request.ttl ? { ttl: request.ttl } : undefined);
        getStats(request.namespace).sets += 1;
        return ok(request, true);
      }
      case 'setIfAbsent': {
        const cache = getOrCreateCache(request.namespace, {});
        if (cache.has(k(request.key))) return ok(request, false);
        cache.set(k(request.key), k(request.value), request.ttl ? { ttl: request.ttl } : undefined);
        getStats(request.namespace).sets += 1;
        return ok(request, true);
      }
      case 'delete': {
        const cache = getOrCreateCache(request.namespace, {});
        const deleted = cache.delete(k(request.key));
        if (deleted) getStats(request.namespace).deletes += 1;
        return ok(request, deleted);
      }
      case 'has': {
        return ok(request, getOrCreateCache(request.namespace, {}).has(k(request.key)));
      }
      case 'peek': {
        return ok(request, getOrCreateCache(request.namespace, {}).peek(k(request.key)));
      }
      case 'getRemainingTTL': {
        return ok(request, getOrCreateCache(request.namespace, {}).getRemainingTTL(k(request.key)));
      }
      case 'clear': {
        getOrCreateCache(request.namespace, {}).clear();
        return ok(request, undefined);
      }
      case 'mGet': {
        const cache = getOrCreateCache(request.namespace, {});
        const s = getStats(request.namespace);
        const out: Array<[unknown, unknown]> = request.keys.map((key) => {
          const value = cache.get(k(key));
          if (value !== undefined) s.hits += 1;
          else s.misses += 1;
          return [key, value];
        });
        return ok(request, out);
      }
      case 'mSet': {
        const cache = getOrCreateCache(request.namespace, {});
        const setOpts = request.ttl ? { ttl: request.ttl } : undefined;
        const s = getStats(request.namespace);
        for (const [key, value] of request.entries) {
          cache.set(k(key), k(value), setOpts);
          s.sets += 1;
        }
        return ok(request, undefined);
      }
      case 'mDelete': {
        const cache = getOrCreateCache(request.namespace, {});
        const s = getStats(request.namespace);
        for (const key of request.keys) {
          if (cache.delete(k(key))) s.deletes += 1;
        }
        return ok(request, undefined);
      }
      case 'keys': {
        return ok(request, [...getOrCreateCache(request.namespace, {}).keys()]);
      }
      case 'values': {
        return ok(request, [...getOrCreateCache(request.namespace, {}).values()]);
      }
      case 'entries': {
        return ok(request, [...getOrCreateCache(request.namespace, {}).entries()]);
      }
      case 'dump': {
        return ok(request, getOrCreateCache(request.namespace, {}).dump());
      }
      case 'load': {
        const cache = getOrCreateCache(request.namespace, {});
        cache.load(request.entries as Array<[NonNullish, LRUCache.Entry<NonNullish>]>);
        return ok(request, undefined);
      }
      case 'size': {
        return ok(request, getOrCreateCache(request.namespace, {}).size);
      }
      case 'stats': {
        const cache = getOrCreateCache(request.namespace, {});
        const s = getStats(request.namespace);
        s.size = cache.size;
        return ok(request, { ...s });
      }
      case 'purgeStale': {
        return ok(request, getOrCreateCache(request.namespace, {}).purgeStale());
      }
      case 'incr':
      case 'decr': {
        const cache = getOrCreateCache(request.namespace, {});
        const existed = cache.has(k(request.key));
        const current = cache.get(k(request.key));
        const base = typeof current === 'number' ? current : 0;
        const delta = (request.amount ?? 1) * (request.op === 'decr' ? -1 : 1);
        const next = base + delta;
        // Rate-limiter semantics: ttl on first write only. For pre-existing
        // keys, noUpdateTTL keeps the original expiration ticking — without
        // it, `cache.set(k, v)` would reset to the cache's default ttl (or
        // strip it entirely if the cache has none).
        const setOpts: { ttl?: number; noUpdateTTL?: boolean } | undefined = existed
          ? { noUpdateTTL: true }
          : request.ttl
            ? { ttl: request.ttl }
            : undefined;
        cache.set(k(request.key), next, setOpts);
        getStats(request.namespace).sets += 1;
        return ok(request, next);
      }
      case 'max': {
        const cache = getOrCreateCache(request.namespace, {});
        if (typeof request.value === 'number' && request.value !== cache.max) {
          // lru-cache@11 has no setter for max — rebuild the cache preserving
          // current entries (most recent first) and other tunables. Reuse the
          // existing stats record so the dispose hook for the new instance
          // continues to count evictions for the same namespace.
          const s = getStats(request.namespace);
          const replacement: AnyCache = new LRUCache({
            max: request.value,
            ttl: (cache as unknown as { ttl: number }).ttl,
            allowStale: (cache as unknown as { allowStale: boolean }).allowStale,
            dispose: (_value: NonNullish, _key: NonNullish, reason: LRUCache.DisposeReason) => {
              if (reason === 'evict') s.evictions += 1;
            },
          });
          for (const [key, value] of cache.entries()) replacement.set(key, value);
          caches.set(request.namespace, replacement);
          return ok(request, replacement.max);
        }
        return ok(request, cache.max);
      }
      case 'ttl': {
        const cache = getOrCreateCache(request.namespace, {});
        if (typeof request.value === 'number') (cache as unknown as { ttl: number }).ttl = request.value;
        return ok(request, (cache as unknown as { ttl: number }).ttl);
      }
      case 'allowStale': {
        const cache = getOrCreateCache(request.namespace, {});
        if (typeof request.value === 'boolean')
          (cache as unknown as { allowStale: boolean }).allowStale = request.value;
        return ok(request, (cache as unknown as { allowStale: boolean }).allowStale);
      }
      default: {
        // After exhaustive cases, request narrows to `never` — at runtime it
        // can still arrive (callers may send a bogus op via untyped IPC).
        const op = (request as { op: string }).op;
        return err(request, `unhandled op: ${op}`);
      }
    }
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
