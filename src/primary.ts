import cluster from 'node:cluster';
import type { Worker } from 'node:cluster';
import Debug from 'debug';
import { LRUCache } from 'lru-cache';
import { SOURCE, type Request, type Response, type SerializableLruOptions } from './messages.js';

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

export function getOrCreateCache(namespace: string, options: SerializableLruOptions): AnyCache {
  let cache = caches.get(namespace);
  if (!cache) {
    cache = new LRUCache({ max: 1000, ...options });
    caches.set(namespace, cache);
    debug(`Created LRUCache for namespace '${namespace}'`);
  }
  return cache;
}

export function handleRequest(request: Request): Response {
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
        return ok(request, getOrCreateCache(request.namespace, {}).get(k(request.key)));
      }
      case 'set': {
        const cache = getOrCreateCache(request.namespace, {});
        cache.set(k(request.key), k(request.value), request.ttl ? { ttl: request.ttl } : undefined);
        return ok(request, true);
      }
      case 'delete': {
        return ok(request, getOrCreateCache(request.namespace, {}).delete(k(request.key)));
      }
      case 'has': {
        return ok(request, getOrCreateCache(request.namespace, {}).has(k(request.key)));
      }
      case 'peek': {
        return ok(request, getOrCreateCache(request.namespace, {}).peek(k(request.key)));
      }
      case 'clear': {
        getOrCreateCache(request.namespace, {}).clear();
        return ok(request, undefined);
      }
      case 'mGet': {
        const cache = getOrCreateCache(request.namespace, {});
        const out: Array<[unknown, unknown]> = request.keys.map((key) => [key, cache.get(k(key))]);
        return ok(request, out);
      }
      case 'mSet': {
        const cache = getOrCreateCache(request.namespace, {});
        const setOpts = request.ttl ? { ttl: request.ttl } : undefined;
        for (const [key, value] of request.entries) cache.set(k(key), k(value), setOpts);
        return ok(request, undefined);
      }
      case 'mDelete': {
        const cache = getOrCreateCache(request.namespace, {});
        for (const key of request.keys) cache.delete(k(key));
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
      case 'size': {
        return ok(request, getOrCreateCache(request.namespace, {}).size);
      }
      case 'purgeStale': {
        return ok(request, getOrCreateCache(request.namespace, {}).purgeStale());
      }
      case 'incr':
      case 'decr': {
        const cache = getOrCreateCache(request.namespace, {});
        const current = cache.get(k(request.key));
        const base = typeof current === 'number' ? current : 0;
        const delta = (request.amount ?? 1) * (request.op === 'decr' ? -1 : 1);
        const next = base + delta;
        cache.set(k(request.key), next);
        return ok(request, next);
      }
      case 'max': {
        const cache = getOrCreateCache(request.namespace, {});
        if (typeof request.value === 'number' && request.value !== cache.max) {
          // lru-cache@11 has no setter for max — rebuild the cache preserving
          // current entries (most recent first) and other tunables.
          const replacement: AnyCache = new LRUCache({
            max: request.value,
            ttl: (cache as unknown as { ttl: number }).ttl,
            allowStale: (cache as unknown as { allowStale: boolean }).allowStale,
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
    return err(request, (e as Error).message);
  }
}

function ok(request: Request, value: unknown): Response {
  return { id: request.id, source: SOURCE, ok: true, value };
}
function err(request: Request, error: string): Response {
  return { id: request.id, source: SOURCE, ok: false, error };
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
