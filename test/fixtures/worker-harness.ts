import cluster from 'node:cluster';
import { gzipSync, gunzipSync } from 'node:zlib';
import { setTimeout } from 'node:timers';
import { LRUCacheForClustersAsPromised, wrap } from '../../src/index.ts';

if (!cluster.isWorker) throw new Error('worker-harness loaded outside a worker');

/* eslint-disable @typescript-eslint/no-empty-object-type */
// V is `{}` (non-nullish) to match the public class generic constraint.
const gzipJsonCodec = {
  encode: (value: {}) => gzipSync(Buffer.from(JSON.stringify(value), 'utf8')),
  decode: (raw: Buffer) => JSON.parse(gunzipSync(raw).toString('utf8')) as {},
};
/* eslint-enable @typescript-eslint/no-empty-object-type */

type CommandMessage = {
  kind?: unknown;
  id?: unknown;
  cmd?: unknown;
  args?: unknown;
};

function isCommandMessage(raw: unknown): raw is CommandMessage & { kind: 'cmd'; id: string; cmd: string } {
  return (
    typeof raw === 'object' &&
    raw !== null &&
    (raw as { kind?: unknown }).kind === 'cmd' &&
    typeof (raw as { id?: unknown }).id === 'string' &&
    typeof (raw as { cmd?: unknown }).cmd === 'string'
  );
}

function serializeError(error: unknown) {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
    };
  }
  return {
    name: 'Error',
    message: String(error),
  };
}

// `{}` is the public generic constraint on V (matches lru-cache@11). Disabled
// for the whole switch since several cases coerce raw IPC payloads through.
/* eslint-disable @typescript-eslint/no-empty-object-type */
async function handleCommand(cmd: string, args: unknown): Promise<unknown> {
  switch (cmd) {
    case 'set': {
      const { options, key, value, ttl } = args as {
        options: ConstructorParameters<typeof LRUCacheForClustersAsPromised>[0];
        key: string;
        value: unknown;
        ttl?: number;
      };
      const cache = await LRUCacheForClustersAsPromised.getInstance<string, {}>(options);
      // value arrives over IPC as `unknown`; the runtime guard rejects null
      // and undefined, so cast to {} to satisfy the public generic constraint.
      return cache.set(key, value as {}, ttl !== undefined ? { ttl } : undefined);
    }

    case 'get': {
      const { options, key } = args as {
        options: ConstructorParameters<typeof LRUCacheForClustersAsPromised>[0];
        key: string;
      };
      const cache = await LRUCacheForClustersAsPromised.getInstance<string, {}>(options);
      return cache.get(key);
    }

    case 'incrMany': {
      const { options, key, count, amount } = args as {
        options: ConstructorParameters<typeof LRUCacheForClustersAsPromised>[0];
        key: string;
        count: number;
        amount?: number;
      };
      const cache = await LRUCacheForClustersAsPromised.getInstance<string, number>(options);
      let last = 0;
      for (let i = 0; i < count; i++) {
        last = await cache.incr(key, amount);
      }
      return last;
    }

    case 'wrappedSet': {
      const { options, key, value, ttl } = args as {
        options: ConstructorParameters<typeof LRUCacheForClustersAsPromised>[0];
        key: string;
        value: unknown;
        ttl?: number;
      };
      const cache = await LRUCacheForClustersAsPromised.getInstance<string, Buffer>(options);
      const wrapped = wrap(cache, gzipJsonCodec);
      return wrapped.set(key, value as {}, ttl !== undefined ? { ttl } : undefined);
    }

    case 'wrappedGet': {
      const { options, key } = args as {
        options: ConstructorParameters<typeof LRUCacheForClustersAsPromised>[0];
        key: string;
      };
      const cache = await LRUCacheForClustersAsPromised.getInstance<string, Buffer>(options);
      const wrapped = wrap(cache, gzipJsonCodec);
      return wrapped.get(key);
    }

    case 'probeReadyConflict': {
      const { options } = args as {
        options: ConstructorParameters<typeof LRUCacheForClustersAsPromised>[0];
      };
      const cache = new LRUCacheForClustersAsPromised(options);
      let threw = false;
      let value: unknown;
      try {
        value = await cache.ready;
      } catch {
        threw = true;
      }
      return { threw, value };
    }

    case 'getInstanceConflict': {
      const { options } = args as {
        options: ConstructorParameters<typeof LRUCacheForClustersAsPromised>[0];
      };
      try {
        await LRUCacheForClustersAsPromised.getInstance(options);
        return { ok: true };
      } catch (error) {
        const serialized = serializeError(error);
        return { ok: false, ...serialized };
      }
    }

    case 'probeMGetMissing': {
      // Returns booleans (JSON-safe) so the test can verify the worker's
      // post-IPC view of mGet without losing the undefined/null distinction
      // a second time when this response itself crosses cluster IPC.
      const { options, presentKey, presentValue, missingKey } = args as {
        options: ConstructorParameters<typeof LRUCacheForClustersAsPromised>[0];
        presentKey: string;
        presentValue: string;
        missingKey: string;
      };
      const cache = await LRUCacheForClustersAsPromised.getInstance<string, string>(options);
      await cache.set(presentKey, presentValue);
      const map = await cache.mGet([presentKey, missingKey]);
      const missingValue = map.get(missingKey);
      return {
        presentMatches: map.get(presentKey) === presentValue,
        missingPresent: map.has(missingKey),
        missingIsUndefined: missingValue === undefined,
        missingIsNull: missingValue === null,
      };
    }

    case 'probeRemainingTTLNoTtl': {
      // Same shape: report a JSON-safe verdict on whether the worker saw
      // Infinity for a no-TTL key (the documented contract).
      const { options, key } = args as {
        options: ConstructorParameters<typeof LRUCacheForClustersAsPromised>[0];
        key: string;
      };
      const cache = await LRUCacheForClustersAsPromised.getInstance<string, string>(options);
      await cache.set(key, 'v');
      const ttl = await cache.getRemainingTTL(key);
      return {
        isInfinity: ttl === Infinity,
        isNull: ttl === null,
        // Stringify so the literal value survives the response IPC hop too.
        stringified: String(ttl),
      };
    }

    case 'getOutcome': {
      const { options, key } = args as {
        options: ConstructorParameters<typeof LRUCacheForClustersAsPromised>[0];
        key: string;
      };
      const cache = await LRUCacheForClustersAsPromised.getInstance<string, {}>(options);
      try {
        const value = await cache.get(key);
        return { status: 'resolved', value };
      } catch (error) {
        const serialized = serializeError(error);
        return { status: 'rejected', ...serialized };
      }
    }

    case 'mGetOutcome': {
      const { options, keys } = args as {
        options: ConstructorParameters<typeof LRUCacheForClustersAsPromised>[0];
        keys: string[];
      };
      const cache = await LRUCacheForClustersAsPromised.getInstance<string, {}>(options);
      try {
        const map = await cache.mGet(keys);
        return { status: 'resolved', size: map.size, isMap: map instanceof Map };
      } catch (error) {
        return { status: 'rejected', ...serializeError(error) };
      }
    }

    case 'rttlOutcome': {
      const { options, key } = args as {
        options: ConstructorParameters<typeof LRUCacheForClustersAsPromised>[0];
        key: string;
      };
      const cache = await LRUCacheForClustersAsPromised.getInstance<string, {}>(options);
      try {
        const value = await cache.getRemainingTTL(key);
        return {
          status: 'resolved',
          isUndefined: value === undefined,
          isInfinity: value === Infinity,
          asString: String(value),
        };
      } catch (error) {
        return { status: 'rejected', ...serializeError(error) };
      }
    }

    case 'exit':
      return { exiting: true };

    default:
      throw new Error(`unknown worker command: ${cmd}`);
  }
}
/* eslint-enable @typescript-eslint/no-empty-object-type */

process.on('message', (raw: unknown) => {
  if (!isCommandMessage(raw)) return;

  void (async () => {
    try {
      const value = await handleCommand(raw.cmd, raw.args);
      process.send?.({ kind: 'resp', id: raw.id, ok: true, value });
      if (raw.cmd === 'exit') {
        setTimeout(() => process.exit(0), 20);
      }
    } catch (error) {
      process.send?.({ kind: 'resp', id: raw.id, ok: false, error: serializeError(error) });
    }
  })();
});

process.send?.({ kind: 'ready', workerId: cluster.worker?.id });
