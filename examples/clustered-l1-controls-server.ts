import cluster from 'node:cluster';
import { createServer, type ServerResponse } from 'node:http';
import { availableParallelism } from 'node:os';
import { fileURLToPath } from 'node:url';
import { LRUCacheClustered } from '../src/index.ts';

const ENTRYPOINT = fileURLToPath(import.meta.url);
const HOST = '127.0.0.1';
const PORT = readPositiveInt('PORT', 3006);
const WORKERS = readPositiveInt('WORKERS', Math.min(availableParallelism(), 4));
const CACHE_TTL_MS = readPositiveInt('CACHE_TTL_MS', 30_000);
const L1_TTL_MS = readPositiveInt('L1_TTL_MS', 2_000);

type ProductRecord = {
  id: string;
  name: string;
  price: number;
  loadedAt: string;
  loadedByPid: number;
  loadedByWorkerId: number | undefined;
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

function startPrimary(): void {
  cluster.setupPrimary({
    exec: ENTRYPOINT,
    execArgv: ['--import', 'tsx'],
  });

  console.log(
    `[primary ${process.pid}] clustered L1 controls example listening on http://${HOST}:${PORT} with ${WORKERS} workers`,
  );

  for (let i = 0; i < WORKERS; i += 1) {
    cluster.fork();
  }

  cluster.on('online', (worker) => {
    console.log(`[primary ${process.pid}] worker ${worker.id} online (pid=${worker.process.pid})`);
  });
}

async function startWorker(): Promise<void> {
  const cache = await LRUCacheClustered.getInstance<string, ProductRecord>({
    namespace: 'example-l1-controls-products',
    max: 10_000,
    ttl: CACHE_TTL_MS,
    localL1: {
      enabled: true,
      experimental: true,
      ttl: L1_TTL_MS,
      // Demonstrates method-level controls: fetch() and memoize()-style reads
      // use L1, while direct get()/has()/peek()/mGet() calls keep going to the
      // primary unless a caller explicitly uses a different cache instance.
      methods: { fetch: true },
    },
  });

  let localOriginLoads = 0;

  const loadProduct = async (id: string): Promise<ProductRecord> => {
    localOriginLoads += 1;
    await sleep(120);
    return {
      id,
      name: `Product ${id}`,
      price: Number.parseFloat((10 + Math.random() * 90).toFixed(2)),
      loadedAt: new Date().toISOString(),
      loadedByPid: process.pid,
      loadedByWorkerId: cluster.worker?.id,
    };
  };

  const server = createServer((req, res) => {
    void (async () => {
      try {
        const url = new URL(req.url ?? '/', `http://${HOST}:${PORT}`);

        if (url.pathname === '/') {
          writeJson(res, 200, {
            example: 'clustered-l1-controls-server',
            routes: {
              fetch: `http://${HOST}:${PORT}/products/42`,
              fresh: `http://${HOST}:${PORT}/products/42/fresh`,
              directGet: `http://${HOST}:${PORT}/products/42/direct-get`,
              seed: `http://${HOST}:${PORT}/products/42/seed`,
              invalidate: `http://${HOST}:${PORT}/products/42/invalidate`,
              stats: `http://${HOST}:${PORT}/stats`,
            },
            localL1: {
              ttlMs: L1_TTL_MS,
              methods: { fetch: true },
            },
            notes: [
              'Call /products/42 repeatedly and watch localStats.ipcAvoided grow on repeated hits to one worker.',
              '/products/42/direct-get uses get(), which is disabled in localL1.methods and goes to the primary.',
              '/products/42/fresh uses withoutLocal() to bypass L1 for a correctness-sensitive read path.',
              '/products/42/seed uses set(..., { updateL1: true }) to warm the caller L1 after a write.',
            ],
          });
          return;
        }

        if (url.pathname === '/stats') {
          writeJson(res, 200, {
            servedBy: { pid: process.pid, workerId: cluster.worker?.id },
            localOriginLoads,
            primaryStats: await cache.stats(),
            localStats: cache.localStats(),
            keys: await cache.keys(),
          });
          return;
        }

        const match = url.pathname.match(/^\/products\/([^/]+)(?:\/([^/]+))?$/);
        if (!match?.[1]) {
          writeJson(res, 404, { error: 'not_found' });
          return;
        }

        const id = decodeURIComponent(match[1]);
        const action = match[2];
        const key = `product:${id}`;

        if (action === 'invalidate') {
          cache.invalidateLocal(key);
          writeJson(res, 200, {
            servedBy: { pid: process.pid, workerId: cluster.worker?.id },
            invalidatedLocalKey: key,
            localStats: cache.localStats(),
          });
          return;
        }

        if (action === 'seed') {
          const product = await loadProduct(id);
          await cache.set(key, product, { ttl: CACHE_TTL_MS, updateL1: true });
          writeJson(res, 200, {
            servedBy: { pid: process.pid, workerId: cluster.worker?.id },
            cacheKey: key,
            used: 'set(updateL1)',
            product,
            localStats: cache.localStats(),
          });
          return;
        }

        if (action === 'direct-get') {
          const product = await cache.get(key);
          writeJson(res, product ? 200 : 404, {
            servedBy: { pid: process.pid, workerId: cluster.worker?.id },
            cacheKey: key,
            used: 'get',
            l1MethodEnabled: false,
            product,
            localStats: cache.localStats(),
          });
          return;
        }

        if (action === 'fresh') {
          const product = await cache.withoutLocal().fetch(key, () => loadProduct(id), { ttl: CACHE_TTL_MS });
          writeJson(res, 200, {
            servedBy: { pid: process.pid, workerId: cluster.worker?.id },
            cacheKey: key,
            used: 'withoutLocal().fetch',
            product,
            localStats: cache.localStats(),
          });
          return;
        }

        if (action !== undefined) {
          writeJson(res, 404, { error: 'not_found' });
          return;
        }

        const product = await cache.fetch(key, () => loadProduct(id), { ttl: CACHE_TTL_MS });
        writeJson(res, 200, {
          servedBy: { pid: process.pid, workerId: cluster.worker?.id },
          cacheKey: key,
          used: 'fetch',
          product,
          localStats: cache.localStats(),
        });
      } catch (error) {
        writeError(res, error);
      }
    })();
  });

  server.listen(PORT, HOST, () => {
    console.log(`[worker ${cluster.worker?.id} pid=${process.pid}] http://${HOST}:${PORT}`);
  });
}

if (cluster.isPrimary) {
  startPrimary();
} else {
  await startWorker();
}
