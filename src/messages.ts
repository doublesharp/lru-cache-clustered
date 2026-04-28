export const SOURCE = 'lru-cache-for-clusters-as-promised' as const;
export type Source = typeof SOURCE;

export type RequestBase = {
  id: string;
  namespace: string;
  source: Source;
};

export type Request = RequestBase &
  (
    | { op: 'init'; options: SerializableLruOptions }
    | { op: 'get'; key: unknown }
    | { op: 'set'; key: unknown; value: unknown; ttl?: number }
    | { op: 'delete'; key: unknown }
    | { op: 'has'; key: unknown }
    | { op: 'peek'; key: unknown }
    | { op: 'clear' }
    | { op: 'purgeStale' }
    | { op: 'mGet'; keys: unknown[] }
    | { op: 'mSet'; entries: Array<[unknown, unknown]>; ttl?: number }
    | { op: 'mDelete'; keys: unknown[] }
    | { op: 'keys' }
    | { op: 'values' }
    | { op: 'entries' }
    | { op: 'dump' }
    | { op: 'size' }
    | { op: 'incr'; key: unknown; amount?: number }
    | { op: 'decr'; key: unknown; amount?: number }
    | { op: 'allowStale'; value?: boolean }
    | { op: 'max'; value?: number }
    | { op: 'ttl'; value?: number }
  );

export type Response = { id: string; source: Source } & (
  | { ok: true; value: unknown }
  | { ok: false; error: string }
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

export type Op = Request['op'];
