import cluster from 'node:cluster';
import { gzipSync, gunzipSync } from 'node:zlib';
import { setTimeout } from 'node:timers';
import { LRUCacheForClustersAsPromised, wrap } from '../../src/index.ts';

if (!cluster.isWorker) throw new Error('worker-harness loaded outside a worker');

const gzipJsonCodec = {
  encode: (value: unknown) => gzipSync(Buffer.from(JSON.stringify(value), 'utf8')),
  decode: (raw: Buffer) => JSON.parse(gunzipSync(raw).toString('utf8')) as unknown,
};

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

async function handleCommand(cmd: string, args: unknown): Promise<unknown> {
  switch (cmd) {
    case 'set': {
      const { options, key, value, ttl } = args as {
        options: ConstructorParameters<typeof LRUCacheForClustersAsPromised>[0];
        key: string;
        value: unknown;
        ttl?: number;
      };
      const cache = await LRUCacheForClustersAsPromised.getInstance<string, unknown>(options);
      return cache.set(key, value, ttl !== undefined ? { ttl } : undefined);
    }

    case 'get': {
      const { options, key } = args as {
        options: ConstructorParameters<typeof LRUCacheForClustersAsPromised>[0];
        key: string;
      };
      const cache = await LRUCacheForClustersAsPromised.getInstance<string, unknown>(options);
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
      return wrapped.set(key, value, ttl !== undefined ? { ttl } : undefined);
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

    case 'getOutcome': {
      const { options, key } = args as {
        options: ConstructorParameters<typeof LRUCacheForClustersAsPromised>[0];
        key: string;
      };
      const cache = await LRUCacheForClustersAsPromised.getInstance<string, unknown>(options);
      try {
        const value = await cache.get(key);
        return { status: 'resolved', value };
      } catch (error) {
        const serialized = serializeError(error);
        return { status: 'rejected', ...serialized };
      }
    }

    case 'exit':
      return { exiting: true };

    default:
      throw new Error(`unknown worker command: ${cmd}`);
  }
}

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
