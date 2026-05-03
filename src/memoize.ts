import type { LRUCacheForClustersAsPromised, WriteOptions } from './index.js';

export type MemoizeOptions = WriteOptions;

// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export function memoize<Args extends unknown[], K extends {}, V extends {}>(
  cache: LRUCacheForClustersAsPromised<K, V>,
  fn: (...args: Args) => Promise<V> | V,
  keyFn: (...args: Args) => K,
  opts?: MemoizeOptions,
): (...args: Args) => Promise<V> {
  return async (...args: Args): Promise<V> => {
    const key = keyFn(...args);
    return cache.fetch(key, () => fn(...args), opts);
  };
}
