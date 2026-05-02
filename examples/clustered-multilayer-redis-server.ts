import cluster from 'node:cluster';
import { createServer, type ServerResponse } from 'node:http';
import { availableParallelism } from 'node:os';
import { fileURLToPath } from 'node:url';
import { LRUCacheClustered } from '../src/index.ts';

const ENTRYPOINT = fileURLToPath(import.meta.url);
const HOST = '127.0.0.1';
const PORT = readPositiveInt('PORT', 3005);
const WORKERS = readPositiveInt('WORKERS', Math.min(availableParallelism(), 4));
const REDIS_URL = process.env.REDIS_URL ?? 'redis://127.0.0.1:6379';
const L1_TTL_MS = readPositiveInt('L1_TTL_MS', 5_000);
const L2_TTL_S = readPositiveInt('L2_TTL_S', 60);
const ORIGIN_LATENCY_MS = readPositiveInt('ORIGIN_LATENCY_MS', 250);

type Source = 'l1' | 'l2' | 'origin';

type ProductRecord = {
  id: string;
  name: string;
  priceCents: number;
  loadedAt: string;
  loadedByPid: number;
  loadedByWorkerId: number | undefined;
};

type RedisLike = {
  connect: () => Promise<void>;
  quit: () => Promise<unknown>;
  get: (key: string) => Promise<string | null>;
  set: (key: string, value: string, options?: { EX?: number }) => Promise<unknown>;
  del: (key: string | string[]) => Promise<number>;
  on: (event: string, listener: (...args: unknown[]) => void) => unknown;
};

function readPositiveInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function writeJson(res: ServerResponse, statusCode: number, body: unknown): void {
  res.writeHead(statusCode, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body, null, 2));
}

function writeError(res: ServerResponse, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  writeJson(res, 500, { error: 'internal_error', message });
}

// The module specifier is built at runtime so neither TypeScript's resolver
// nor eslint-import-x's static analysis tries to resolve `redis` — keeping
// this example free of a hard dependency on the package. Install it
// (`pnpm add -D redis`) to actually run the example.
const REDIS_MODULE = ['re', 'dis'].join('');

async function loadRedisClient(): Promise<RedisLike> {
  let mod: { createClient: (opts: { url: string }) => RedisLike };
  try {
    mod = (await import(REDIS_MODULE)) as {
      createClient: (opts: { url: string }) => RedisLike;
    };
  } catch {
    throw new Error('This example requires the `redis` package. Install it with: pnpm add -D redis');
  }
  const client = mod.createClient({ url: REDIS_URL });
  client.on('error', (err) => {
    console.error(`[worker ${cluster.worker?.id} pid=${process.pid}] redis error`, err);
  });
  await client.connect();
  return client;
}

function startPrimary(): void {
  cluster.setupPrimary({
    exec: ENTRYPOINT,
    execArgv: ['--import', 'tsx'],
  });

  console.log(
    `[primary ${process.pid}] multilayer (LRU + Redis) example listening on http://${HOST}:${PORT} with ${WORKERS} workers`,
  );
  console.log(`[primary ${process.pid}] redis url: ${REDIS_URL}`);

  for (let i = 0; i < WORKERS; i += 1) {
    cluster.fork();
  }

  cluster.on('online', (worker) => {
    console.log(`[primary ${process.pid}] worker ${worker.id} online (pid=${worker.process.pid})`);
  });
}

async function startWorker(): Promise<void> {
  // L1: clustered, in-process LRU shared across every worker via the primary.
  // Sub-millisecond hits, no network. Holds the hottest keys.
  const l1 = await LRUCacheClustered.getInstance<string, ProductRecord>({
    namespace: 'example-multilayer-products',
    max: 1_000,
    ttl: L1_TTL_MS,
  });

  // L2: Redis. Survives restarts, shared across machines, larger capacity.
  const redis = await loadRedisClient();

  const fetchFromOrigin = async (id: string): Promise<ProductRecord> => {
    await sleep(ORIGIN_LATENCY_MS);
    const record: ProductRecord = {
      id,
      name: `Product ${id}`,
      priceCents: 100 + (Number.parseInt(id, 10) || id.length) * 17,
      loadedAt: new Date().toISOString(),
      loadedByPid: process.pid,
      loadedByWorkerId: cluster.worker?.id,
    };
    console.log(`[worker ${cluster.worker?.id} pid=${process.pid}] origin load product:${id}`);
    return record;
  };

  // Returns the value plus which layer answered. Cluster-wide single-flight
  // through cache.fetch() ensures concurrent L1 misses for the same key
  // collapse to one Redis read (and at most one origin call) across workers.
  const getProduct = async (id: string): Promise<{ source: Source; product: ProductRecord }> => {
    let source: Source = 'l1';
    const key = `product:${id}`;

    const product = await l1.fetch(
      key,
      async () => {
        // L1 missed and we are the leader for this key across the cluster.
        const raw = await redis.get(`l2:${key}`);
        if (raw) {
          source = 'l2';
          return JSON.parse(raw) as ProductRecord;
        }

        // L2 missed too. Hit origin and write through to Redis on the way back.
        source = 'origin';
        const fresh = await fetchFromOrigin(id);
        await redis.set(`l2:${key}`, JSON.stringify(fresh), { EX: L2_TTL_S });
        return fresh;
      },
      { ttl: L1_TTL_MS },
    );

    return { source, product };
  };

  const invalidate = async (id: string): Promise<{ l1Deleted: boolean; l2Deleted: number }> => {
    const key = `product:${id}`;
    const [l1Deleted, l2Deleted] = await Promise.all([l1.delete(key), redis.del(`l2:${key}`)]);
    return { l1Deleted, l2Deleted };
  };

  const server = createServer((req, res) => {
    void (async () => {
      try {
        const url = new URL(req.url ?? '/', `http://${HOST}:${PORT}`);

        if (url.pathname === '/') {
          writeJson(res, 200, {
            example: 'clustered-multilayer-redis-server',
            layers: {
              l1: 'clustered LRU on the primary (in-process, shared across workers)',
              l2: 'Redis (shared across machines, survives restarts)',
              origin: `simulated upstream (sleeps ${ORIGIN_LATENCY_MS}ms)`,
            },
            routes: {
              get: `http://${HOST}:${PORT}/products/42`,
              invalidate: `http://${HOST}:${PORT}/products/42/invalidate`,
              stats: `http://${HOST}:${PORT}/stats`,
            },
            notes: [
              'Call /products/42 once: source=origin (cold). Again within 5s: source=l1.',
              'Wait >5s but <60s and call again: L1 expired, source=l2, then re-warmed in L1.',
              'Invalidate the key, then call again: source=origin.',
              'Open many concurrent calls to a cold key: only one worker reaches origin.',
            ],
          });
          return;
        }

        if (url.pathname === '/stats') {
          writeJson(res, 200, {
            servedBy: { pid: process.pid, workerId: cluster.worker?.id },
            l1: {
              stats: await l1.stats(),
              keys: await l1.keys(),
            },
            redisUrl: REDIS_URL,
          });
          return;
        }

        const invalidateMatch = url.pathname.match(/^\/products\/([^/]+)\/invalidate$/);
        if (invalidateMatch) {
          const rawId = invalidateMatch[1];
          if (!rawId) {
            writeJson(res, 404, { error: 'not_found' });
            return;
          }
          const id = decodeURIComponent(rawId);
          const result = await invalidate(id);
          writeJson(res, 200, {
            servedBy: { pid: process.pid, workerId: cluster.worker?.id },
            id,
            ...result,
          });
          return;
        }

        const getMatch = url.pathname.match(/^\/products\/([^/]+)$/);
        if (!getMatch) {
          writeJson(res, 404, { error: 'not_found' });
          return;
        }

        const rawId = getMatch[1];
        if (!rawId) {
          writeJson(res, 404, { error: 'not_found' });
          return;
        }

        const id = decodeURIComponent(rawId);
        const { source, product } = await getProduct(id);

        writeJson(res, 200, {
          servedBy: { pid: process.pid, workerId: cluster.worker?.id },
          source,
          wasLoadedByAnotherWorker: product.loadedByPid !== process.pid,
          product,
        });
      } catch (error) {
        writeError(res, error);
      }
    })();
  });

  const shutdown = async (): Promise<void> => {
    try {
      await redis.quit();
    } catch {
      // ignore — we're exiting anyway
    }
    server.close(() => process.exit(0));
  };

  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());

  server.listen(PORT, HOST, () => {
    console.log(`[worker ${cluster.worker?.id} pid=${process.pid}] http://${HOST}:${PORT}`);
  });
}

if (cluster.isPrimary) {
  startPrimary();
} else {
  await startWorker();
}
