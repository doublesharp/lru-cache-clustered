import Debug from 'debug';
import { DEBUG_PREFIX, type InvalidationPush } from './messages.js';

type Handler = (msg: InvalidationPush) => void;
const key = Symbol.for('lru-cache-clustered.invalidations');
const subscribers = ((globalThis as Record<PropertyKey, unknown>)[key] ??= new Map<string, Set<Handler>>()) as Map<
  string,
  Set<Handler>
>;
const debug = Debug(`${DEBUG_PREFIX}-invalidations`);

export function subscribeInvalidations(namespace: string, handler: Handler): () => void {
  let handlers = subscribers.get(namespace);
  if (!handlers) subscribers.set(namespace, (handlers = new Set()));
  handlers.add(handler);
  return () => {
    handlers.delete(handler);
    if (handlers.size === 0 && subscribers.get(namespace) === handlers) subscribers.delete(namespace);
  };
}

export function emitInvalidation(msg: InvalidationPush): void {
  for (const handler of subscribers.get(msg.namespace) ?? []) {
    try {
      handler(msg);
    } catch (error) {
      debug('local invalidation subscriber failed: %s', error);
    }
  }
}
