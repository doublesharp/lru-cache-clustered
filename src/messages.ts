// Short sentinel for IPC payload filtering. Each request and response carries
// this string so the listener can ignore foreign messages on the shared cluster
// IPC channel. Kept short (6 bytes) to minimize wire overhead — at 10k ops/sec
// the savings versus a long package-name string add up to ~500KB/sec.
export const SOURCE = 'lcfcap' as const;
type Source = typeof SOURCE;

// Debug namespace prefix kept as the full package name so the documented
// `DEBUG=lru-cache-for-clusters-as-promised-*` env var continues to work.
export const DEBUG_PREFIX = 'lru-cache-for-clusters-as-promised';

type RequestBase = {
  id: string;
  namespace: string;
  source: Source;
};

export type Request = RequestBase &
  (
    | { op: 'init'; options: SerializableLruOptions }
    | { op: 'get'; key: unknown }
    | { op: 'set'; key: unknown; value: unknown; ttl?: number }
    | { op: 'setIfAbsent'; key: unknown; value: unknown; ttl?: number }
    | { op: 'delete'; key: unknown }
    | { op: 'has'; key: unknown }
    | { op: 'peek'; key: unknown }
    | { op: 'getRemainingTTL'; key: unknown }
    | { op: 'clear' }
    | { op: 'purgeStale' }
    | { op: 'mGet'; keys: unknown[] }
    | { op: 'mSet'; entries: Array<[unknown, unknown]>; ttl?: number }
    | { op: 'mDelete'; keys: unknown[] }
    | { op: 'keys' }
    | { op: 'values' }
    | { op: 'entries' }
    | { op: 'dump' }
    | { op: 'load'; entries: Array<[unknown, unknown]> }
    | { op: 'size' }
    | { op: 'stats' }
    | { op: 'incr'; key: unknown; amount?: number; ttl?: number }
    | { op: 'decr'; key: unknown; amount?: number; ttl?: number }
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

export function serializeError(err: unknown): SerializedError {
  if (err instanceof Error) {
    const out: SerializedError = { name: err.name, message: err.message };
    if (err.stack) out.stack = err.stack;
    const code = (err as { code?: unknown }).code;
    if (typeof code === 'string' || typeof code === 'number') out.code = code;
    const cause = (err as { cause?: unknown }).cause;
    if (cause !== undefined) out.cause = serializeError(cause);
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
