import cluster from 'node:cluster';
import { randomUUID } from 'node:crypto';
import { LRUCache } from 'lru-cache';
import {
  caches,
  getOrCreateCache,
  handleRequest,
  installClusterListener,
} from './primary.js';
import {
  defaultClient,
  type IpcClient,
  type RequestPayload,
} from './worker.js';
import {
  SOURCE,
  type Request,
  type Response,
  type SerializableLruOptions,
} from './messages.js';

if (cluster.isPrimary) installClusterListener();

// lru-cache@11 constrains generic K and V to non-nullish; mirror that locally
// so the registry's stored type lines up with the public getCache() return.
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
type NonNullish = {};

export interface LRUCacheClusterOptions extends SerializableLruOptions {
  namespace?: string;
  timeout?: number;
  failsafe?: 'resolve' | 'reject';
}

interface InternalOptions {
  noInit?: boolean;
}

export class LRUCacheForClustersAsPromised<K = string, V = unknown> {
  readonly namespace: string;
  readonly timeout: number;
  readonly failsafe: 'resolve' | 'reject';
  readonly #lruOptions: SerializableLruOptions;
  readonly #client: IpcClient;

  constructor(options: LRUCacheClusterOptions & InternalOptions = {}) {
    this.namespace = options.namespace ?? 'default';
    this.timeout = options.timeout ?? 100;
    this.failsafe = options.failsafe === 'reject' ? 'reject' : 'resolve';
    const {
      namespace: _n,
      timeout: _t,
      failsafe: _f,
      noInit: _ni,
      ...lruOpts
    } = options;
    void _n;
    void _t;
    void _f;
    void _ni;
    this.#lruOptions = lruOpts;
    this.#client = defaultClient;

    if (cluster.isPrimary) {
      getOrCreateCache(this.namespace, this.#lruOptions);
    } else if (!options.noInit) {
      void this.#dispatch<unknown>({ op: 'init', options: this.#lruOptions });
    }
  }

  static async getInstance<K = string, V = unknown>(
    options: LRUCacheClusterOptions = {},
  ): Promise<LRUCacheForClustersAsPromised<K, V>> {
    const instance = new LRUCacheForClustersAsPromised<K, V>({
      ...options,
      noInit: true,
    });
    if (cluster.isWorker) {
      await instance.#dispatch<unknown>({
        op: 'init',
        options: instance.#lruOptions,
      });
    }
    return instance;
  }

  static getAllCaches(): Map<string, LRUCache<NonNullish, NonNullish>> {
    if (cluster.isWorker) {
      throw new Error(
        'LRUCacheForClustersAsPromised.getAllCaches() must not be called from a worker',
      );
    }
    return caches;
  }

  getCache(): LRUCache<NonNullish, NonNullish> | undefined {
    if (cluster.isWorker) {
      throw new Error(
        'LRUCacheForClustersAsPromised.getCache() must not be called from a worker',
      );
    }
    return caches.get(this.namespace);
  }

  // Per-method API:
  get(key: K) {
    return this.#dispatch<V | undefined>({ op: 'get', key });
  }
  set(key: K, value: V, opts?: { ttl?: number }) {
    return this.#dispatch<boolean>({
      op: 'set',
      key,
      value,
      ttl: opts?.ttl,
    });
  }
  delete(key: K) {
    return this.#dispatch<boolean>({ op: 'delete', key });
  }
  has(key: K) {
    return this.#dispatch<boolean>({ op: 'has', key });
  }
  peek(key: K) {
    return this.#dispatch<V | undefined>({ op: 'peek', key });
  }
  clear() {
    return this.#dispatch<void>({ op: 'clear' });
  }
  purgeStale() {
    return this.#dispatch<boolean>({ op: 'purgeStale' });
  }

  async mGet(keys: K[]): Promise<Map<K, V | undefined>> {
    const pairs = await this.#dispatch<Array<[K, V | undefined]>>({
      op: 'mGet',
      keys: keys as unknown[],
    });
    return new Map(pairs);
  }
  mSet(entries: Iterable<[K, V]>, opts?: { ttl?: number }) {
    return this.#dispatch<void>({
      op: 'mSet',
      entries: [...entries] as Array<[unknown, unknown]>,
      ttl: opts?.ttl,
    });
  }
  mDelete(keys: K[]) {
    return this.#dispatch<void>({ op: 'mDelete', keys: keys as unknown[] });
  }

  keys() {
    return this.#dispatch<K[]>({ op: 'keys' });
  }
  values() {
    return this.#dispatch<V[]>({ op: 'values' });
  }
  entries() {
    return this.#dispatch<Array<[K, V]>>({ op: 'entries' });
  }
  dump() {
    return this.#dispatch<Array<[K, LRUCache.Entry<V>]>>({ op: 'dump' });
  }
  size() {
    return this.#dispatch<number>({ op: 'size' });
  }

  incr(key: K, amount?: number) {
    return this.#dispatch<number>({ op: 'incr', key, amount });
  }
  decr(key: K, amount?: number) {
    return this.#dispatch<number>({ op: 'decr', key, amount });
  }

  allowStale(value?: boolean) {
    return this.#dispatch<boolean>({ op: 'allowStale', value });
  }
  max(value?: number) {
    return this.#dispatch<number>({ op: 'max', value });
  }
  ttl(value?: number) {
    return this.#dispatch<number>({ op: 'ttl', value });
  }

  #dispatch<T>(payload: RequestPayload): Promise<T> {
    if (cluster.isPrimary) {
      const req: Request = {
        id: randomUUID(),
        namespace: this.namespace,
        source: SOURCE,
        ...payload,
      } as Request;
      const res: Response = handleRequest(req);
      if (res.ok) return Promise.resolve(res.value as T);
      return Promise.reject(new Error(res.error));
    }
    return this.#client.sendToPrimary<T>(
      {
        namespace: this.namespace,
        timeout: this.timeout,
        failsafe: this.failsafe,
      },
      payload,
    );
  }
}

export default LRUCacheForClustersAsPromised;
