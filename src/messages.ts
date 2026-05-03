// Short sentinel for IPC payload filtering. Each request and response carries
// this string so the listener can ignore foreign messages on the shared cluster
// IPC channel. Kept short (6 bytes) to minimize wire overhead — at 10k ops/sec
// the savings versus a long package-name string add up to ~500KB/sec.
export const SOURCE = 'lcfcap' as const;
type Source = typeof SOURCE;

// Keep the debug namespace unscoped so it stays ergonomic in `DEBUG=...` and
// stable across the canonical scoped package and the mirrored legacy publish.
export const DEBUG_PREFIX = 'lru-cache-clustered';

type RequestBase = {
  id: string;
  namespace: string;
  source: Source;
  cacheOptions?: SerializableLruOptions;
};

export type Request = RequestBase &
  (
    | { op: 'init'; options: SerializableLruOptions }
    | { op: 'healthCheck' }
    | { op: 'destroy' }
    | { op: 'get'; key: unknown }
    | { op: 'set'; key: unknown; value: unknown; ttl?: number; size?: number }
    | { op: 'setIfAbsent'; key: unknown; value: unknown; ttl?: number; size?: number }
    | { op: 'delete'; key: unknown }
    | { op: 'has'; key: unknown }
    | { op: 'peek'; key: unknown }
    | { op: 'getRemainingTTL'; key: unknown }
    | { op: 'clear' }
    | { op: 'purgeStale' }
    | { op: 'mGet'; keys: unknown[] }
    | {
        op: 'mSet';
        entries: Array<[unknown, unknown] | [unknown, unknown, { ttl?: number; size?: number }]>;
        ttl?: number;
        size?: number;
      }
    | { op: 'mDelete'; keys: unknown[] }
    | { op: 'keys' }
    | { op: 'values' }
    | { op: 'entries' }
    | { op: 'dump' }
    | { op: 'load'; entries: Array<[unknown, unknown]> }
    | { op: 'size' }
    | { op: 'stats' }
    | { op: 'incr'; key: unknown; amount?: number; ttl?: number; size?: number }
    | { op: 'decr'; key: unknown; amount?: number; ttl?: number; size?: number }
    | { op: 'fetchClaim'; key: unknown; forceRefresh?: boolean }
    | { op: 'fetchStore'; key: unknown; token: string; value: unknown; ttl?: number; size?: number }
    | { op: 'fetchAbort'; key: unknown; token: string }
    | { op: 'allowStale'; value?: boolean }
    | { op: 'max'; value?: number }
    | { op: 'ttl'; value?: number }
  );

// Errors flow over IPC as a structured payload so consumers can branch on
// `name`/`code`/`cause` instead of regex-matching a `message` string. Internal
// to the wire format — workers receive a reconstructed `Error` via
// `deserializeError`, never this raw shape.
type SerializedError = {
  name: string;
  message: string;
  code?: string | number;
  stack?: string;
  cause?: SerializedError;
};

export type Response = { id: string; source: Source } & (
  | { ok: true; value: unknown }
  | { ok: false; error: SerializedError }
);

// Subset of LRUCache.Options that survives IPC structured-clone — no functions.
export type SerializableLruOptions = {
  max?: number;
  maxSize?: number;
  maxEntrySize?: number;
  ttl?: number;
  allowStale?: boolean;
  updateAgeOnGet?: boolean;
  updateAgeOnHas?: boolean;
  noDeleteOnStaleGet?: boolean;
  ttlAutopurge?: boolean;
};

export type Stats = {
  namespace: string;
  hits: number;
  misses: number;
  sets: number;
  deletes: number;
  evictions: number;
  size: number;
};

// Cause chains are walked recursively. Cap depth and detect cycles so a
// pathological error (self-referential cause, or a chain dozens deep)
// cannot stack-overflow the primary's IPC message handler and crash the
// cluster.
const SERIALIZE_CAUSE_MAX_DEPTH = 8;

export function serializeError(err: unknown): SerializedError {
  return serializeErrorAt(err, 0, new Set());
}

function serializeErrorAt(err: unknown, depth: number, seen: Set<object>): SerializedError {
  if (err instanceof Error) {
    if (seen.has(err)) {
      return { name: err.name, message: '[circular cause]' };
    }
    seen.add(err);
    const out: SerializedError = { name: err.name, message: err.message };
    if (err.stack) out.stack = err.stack;
    const code = (err as { code?: unknown }).code;
    if (typeof code === 'string' || typeof code === 'number') out.code = code;
    const cause = (err as { cause?: unknown }).cause;
    if (cause !== undefined) {
      if (depth + 1 >= SERIALIZE_CAUSE_MAX_DEPTH) {
        out.cause = { name: 'Error', message: '[cause chain truncated]' };
      } else {
        out.cause = serializeErrorAt(cause, depth + 1, seen);
      }
    }
    return out;
  }
  return { name: 'Error', message: typeof err === 'string' ? err : String(err) };
}

export function deserializeError(payload: SerializedError): Error {
  const err = new Error(payload.message);
  err.name = payload.name;
  if (payload.stack) err.stack = payload.stack;
  if (payload.code !== undefined) (err as { code?: unknown }).code = payload.code;
  if (payload.cause !== undefined) (err as { cause?: unknown }).cause = deserializeError(payload.cause);
  return err;
}
