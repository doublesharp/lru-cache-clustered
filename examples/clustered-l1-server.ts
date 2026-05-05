/**
 * clustered-l1-server.ts
 *
 * Demonstrates the local L1 cache: a per-worker LRU cache in front of the
 * primary-owned shared cache. Hot reads skip IPC entirely.
 *
 * Run: node --import tsx examples/clustered-l1-server.ts
 *
 * Try:
 *   curl http://127.0.0.1:3004/products/42   # first call loads from "database"
 *   curl http://127.0.0.1:3004/products/42   # second call: L1 hit, no IPC
 *   curl http://127.0.0.1:3004/stats
 */

import cluster from 'node:cluster';
import { createServer, type ServerResponse } from 'node:http';
import { availableParallelism } from 'node:os';
import { fileURLToPath } from 'node:url';
import { LRUCacheClustered } from '../src/index.ts';

const ENTRYPOINT = fileURLToPath(import.meta.url);
const HOST = '127.0.0.1';
const PORT = readPositiveInt('PORT', 3004);
const WORKERS = readPositiveInt('WORKERS', Math.min(availableParallelism(), 4));
const CACHE_TTL_MS = readPositiveInt('CACHE_TTL_MS', 30_000);
// L1 TTL is much shorter -- stale data window is bounded to this interval.
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
    `[primary ${process.pid}] clustered l1 example listening on http://${HOST}:${PORT} with ${WORKERS} workers`,
  );

  for (let i = 0; i < WORKERS; i += 1) {
    cluster.fork();
  }

  cluster.on('online', (worker) => {
    console.log(`[primary ${process.pid}] worker ${worker.id} online (pid=${worker.process.pid})`);
  });

  cluster.on('exit', (worker, code, signal) => {
    console.log(
      `[primary ${process.pid}] worker ${worker.id} exited (pid=${worker.process.pid}, code=${code}, signal=${signal ?? 'none'})`,
    );
  });
}

async function startWorker(): Promise<void> {
  // L1 is enabled with a short TTL. Repeated reads for the same key within
  // the L1 TTL window are served from process-local memory with no IPC hop.
  const cache = await LRUCacheClustered.getInstance<string, ProductRecord>({
    namespace: 'example-products',
    max: 10_000,
    ttl: CACHE_TTL_MS,
    localL1: { enabled: true, experimental: true, ttl: L1_TTL_MS },
  });

  const loadProduct = async (id: string): Promise<ProductRecord> => {
    // Simulate a slow database call.
    await sleep(150);
    const record = {
      id,
      name: `Product ${id}`,
      price: Number.parseFloat((Math.random() * 100).toFixed(2)),
      loadedAt: new Date().toISOString(),
      loadedByPid: process.pid,
      loadedByWorkerId: cluster.worker?.id,
    };
    console.log(`[worker ${cluster.worker?.id} pid=${process.pid}] loaded product:${id} from db`);
    return record;
  };

  const server = createServer((req, res) => {
    void (async () => {
      try {
        const url = new URL(req.url ?? '/', `http://${HOST}:${PORT}`);

        if (url.pathname === '/') {
          writeJson(res, 200, {
            example: 'clustered-l1-server',
            routes: {
              product: `http://${HOST}:${PORT}/products/42`,
              fresh: `http://${HOST}:${PORT}/products/42?bypass=1`,
              stats: `http://${HOST}:${PORT}/stats`,
            },
            notes: [
              `L1 TTL is ${L1_TTL_MS} ms. Calls within that window skip IPC.`,
              'Watch localStats.ipcAvoided grow with repeated requests to the same worker.',
              'Use ?bypass=1 to skip L1 and always round-trip to the primary.',
            ],
          });
          return;
        }

        if (url.pathname === '/stats') {
          writeJson(res, 200, {
            servedBy: { pid: process.pid, workerId: cluster.worker?.id },
            primaryStats: await cache.stats(),
            localStats: cache.localStats(),
          });
          return;
        }

        const match = url.pathname.match(/^\/products\/([^/]+)$/);
        if (!match) {
          writeJson(res, 404, { error: 'not_found' });
          return;
        }

        const rawId = match[1];
        if (!rawId) {
          writeJson(res, 404, { error: 'not_found' });
          return;
        }

        const id = decodeURIComponent(rawId);
        const bypass = url.searchParams.get('bypass') === '1';
        const key = `product:${id}`;

        let product: ProductRecord | undefined;
        if (bypass) {
          // bypassL1: true forces an IPC read to the primary even when L1 has
          // a fresh entry. Use this for correctness-sensitive reads.
          product = await cache.get(key, { bypassL1: true });
        } else {
          product = await cache.get(key);
        }

        if (!product) {
          product = await loadProduct(id);
          await cache.set(key, product, { ttl: CACHE_TTL_MS });
        }

        writeJson(res, 200, {
          servedBy: { pid: process.pid, workerId: cluster.worker?.id },
          cacheKey: key,
          bypassedL1: bypass,
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
