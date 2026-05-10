import type { FetchOptions, LRUCacheClustered } from './index.js';

export type MemoizeOptions = FetchOptions;

// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export function memoize<Args extends unknown[], K extends {}, V extends {}>(
  cache: LRUCacheClustered<K, V>,
  fn: (...args: Args) => Promise<V> | V,
  keyFn: (...args: Args) => K,
  opts?: MemoizeOptions,
): (...args: Args) => Promise<V> {
  return async (...args: Args): Promise<V> => {
    const key = keyFn(...args);
    return cache.fetch(key, () => fn(...args), opts);
  };
}
