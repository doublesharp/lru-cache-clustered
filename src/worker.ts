import { setTimeout, clearTimeout } from 'node:timers';
import Debug from 'debug';
import {
  DEBUG_PREFIX,
  SOURCE,
  deserializeError,
  isInvalidationPush,
  type InvalidationPush,
  type Request,
  type Response,
} from './messages.js';

const messagesDebug = Debug(`${DEBUG_PREFIX}-messages`);

// Monotonic per-process request ID, shared across all IpcClient instances
// in this worker. Uniqueness within the process is the only requirement —
// the primary keys responses by id and only this worker reads them back.
// Avoids randomUUID's ~1µs cost and keeps wire-format IDs short (1-10
// chars vs UUID's 36).
let nextRequestId = 0;

type SendOptions = {
  namespace: string;
  timeout: number;
  failsafe: 'resolve' | 'reject';
};

type ProcessLike = {
  send: (msg: unknown) => boolean | void;
  on: (event: 'message', cb: (msg: unknown) => void) => void;
};

// Distributive Omit so each member of the Request discriminated union keeps its own shape.
type DistributiveOmit<T, K extends keyof never> = T extends unknown ? Omit<T, K> : never;
type RequestPayload = DistributiveOmit<Request, 'id' | 'namespace' | 'source'>;

type InvalidationHandler = (msg: InvalidationPush) => void;

interface IpcClient {
  sendToPrimary: <T = unknown>(opts: SendOptions, payload: RequestPayload) => Promise<T>;
  sendToPrimaryWithMeta: <T = unknown>(
    opts: SendOptions,
    payload: RequestPayload,
  ) => Promise<{ value: T; version: number }>;
  subscribeInvalidations: (namespace: string, handler: InvalidationHandler) => () => void;
}

export function createIpcClient(proc: ProcessLike): IpcClient {
  const callbacks = new Map<string, (response: Response) => void>();
  const subscribers = new Map<string, Set<InvalidationHandler>>();

  proc.on('message', (raw: unknown) => {
    if (isOurResponse(raw)) {
      const cb = callbacks.get(raw.id);
      if (!cb) return;
      callbacks.delete(raw.id);
      cb(raw);
      return;
    }
    if (isInvalidationPush(raw)) {
      const set = subscribers.get(raw.namespace);
      if (!set) return;
      for (const handler of set) {
        try {
          handler(raw);
        } catch (err) {
          messagesDebug('invalidation handler threw: %o', err);
        }
      }
      return;
    }
  });

  function send<T>(opts: SendOptions, payload: RequestPayload): Promise<{ value: T; version: number }> {
    const id = String(++nextRequestId);
    const request = { id, namespace: opts.namespace, source: SOURCE, ...payload } as Request;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        callbacks.delete(id);
        if (opts.failsafe === 'reject') reject(new Error('IPC timeout'));
        else resolve({ value: undefined as T, version: 0 });
      }, opts.timeout);

      callbacks.set(id, (response) => {
        clearTimeout(timer);
        if (response.ok) resolve({ value: response.value as T, version: response.version ?? 0 });
        else reject(deserializeError(response.error));
      });

      messagesDebug('worker -> primary', request);
      try {
        // proc.send returns false when the IPC channel is full
        // (backpressure). The message is silently dropped, so the response
        // would never arrive and the caller would block until the timeout
        // fires. Fast-fail here so backpressure surfaces immediately under
        // the configured failsafe.
        const sent = proc.send(request);
        if (sent === false) {
          clearTimeout(timer);
          callbacks.delete(id);
          if (opts.failsafe === 'reject') reject(new Error('IPC backpressure'));
          else resolve({ value: undefined as T, version: 0 });
        }
      } catch (error) {
        clearTimeout(timer);
        callbacks.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  return {
    async sendToPrimary<T>(opts: SendOptions, payload: RequestPayload): Promise<T> {
      const r = await send<T>(opts, payload);
      return r.value;
    },
    sendToPrimaryWithMeta: <T>(opts: SendOptions, payload: RequestPayload) => send<T>(opts, payload),
    subscribeInvalidations(namespace: string, handler: InvalidationHandler): () => void {
      let set = subscribers.get(namespace);
      if (!set) {
        set = new Set();
        subscribers.set(namespace, set);
      }
      set.add(handler);
      return () => {
        const s = subscribers.get(namespace);
        if (!s) return;
        s.delete(handler);
        if (s.size === 0) subscribers.delete(namespace);
      };
    },
  };
}

function isOurResponse(value: unknown): value is Response {
  if (
    typeof value !== 'object' ||
    value === null ||
    (value as { source?: unknown }).source !== SOURCE ||
    typeof (value as { id?: unknown }).id !== 'string' ||
    typeof (value as { ok?: unknown }).ok !== 'boolean'
  ) {
    return false;
  }
  // When ok=false, validate the error payload shape too. Without this guard a
  // malformed error from a misbehaving primary would crash the message
  // listener in deserializeError(undefined) and take the worker down.
  if ((value as { ok: boolean }).ok === false) {
    const error = (value as { error?: unknown }).error;
    if (
      typeof error !== 'object' ||
      error === null ||
      typeof (error as { name?: unknown }).name !== 'string' ||
      typeof (error as { message?: unknown }).message !== 'string'
    ) {
      return false;
    }
  }
  return true;
}

// Lazy singleton for the actual worker process. Constructing the client
// attaches a `process.on('message')` listener and captures `process.send`,
// neither of which is meaningful in primary mode — so we defer creation
// until a worker-side dispatch actually needs it.
let cachedDefaultClient: IpcClient | undefined;

export function getDefaultClient(): IpcClient {
  if (!cachedDefaultClient) {
    if (typeof process.send !== 'function') {
      throw new Error(
        'lru-cache-clustered: worker IPC client requested in a process without `process.send` (not a cluster worker).',
      );
    }
    const send = process.send.bind(process);
    cachedDefaultClient = createIpcClient({
      send: (msg) => send(msg),
      on: (event, cb) => process.on(event, cb),
    });
  }
  return cachedDefaultClient;
}
