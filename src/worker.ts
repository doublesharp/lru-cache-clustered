import { randomUUID } from 'node:crypto';
import { setTimeout, clearTimeout } from 'node:timers';
import Debug from 'debug';
import { SOURCE, deserializeError, type Request, type Response } from './messages.js';

const messagesDebug = Debug(`${SOURCE}-messages`);

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
export type RequestPayload = DistributiveOmit<Request, 'id' | 'namespace' | 'source'>;

export interface IpcClient {
  sendToPrimary: <T = unknown>(opts: SendOptions, payload: RequestPayload) => Promise<T>;
}

export function createIpcClient(proc: ProcessLike): IpcClient {
  const callbacks = new Map<string, (response: Response) => void>();

  proc.on('message', (raw: unknown) => {
    if (!isOurResponse(raw)) return;
    const cb = callbacks.get(raw.id);
    if (!cb) return;
    callbacks.delete(raw.id);
    cb(raw);
  });

  return {
    sendToPrimary<T>(opts: SendOptions, payload: RequestPayload): Promise<T> {
      const id = randomUUID();
      const request = { id, namespace: opts.namespace, source: SOURCE, ...payload } as Request;

      return new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => {
          callbacks.delete(id);
          if (opts.failsafe === 'reject') reject(new Error('IPC timeout'));
          else resolve(undefined as T);
        }, opts.timeout);

        callbacks.set(id, (response) => {
          clearTimeout(timer);
          if (response.ok) resolve(response.value as T);
          else reject(deserializeError(response.error));
        });

        messagesDebug('worker -> primary', request);
        proc.send(request);
      });
    },
  };
}

function isOurResponse(value: unknown): value is Response {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { source?: unknown }).source === SOURCE &&
    typeof (value as { id?: unknown }).id === 'string'
  );
}

// Default singleton for the actual worker process (real `process` object).
// Caller is expected to be a cluster worker, so process.send is defined.
export const defaultClient: IpcClient = createIpcClient({
  send: (msg) => process.send!(msg),
  on: (event, cb) => process.on(event, cb),
});
