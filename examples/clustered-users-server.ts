import cluster from 'node:cluster';
import { createServer, type ServerResponse } from 'node:http';
import { availableParallelism } from 'node:os';
import { fileURLToPath } from 'node:url';
import { LRUCacheClustered, memoize } from '../src/index.ts';

const ENTRYPOINT = fileURLToPath(import.meta.url);
const HOST = '127.0.0.1';
const PORT = readPositiveInt('PORT', 3000);
const WORKERS = readPositiveInt('WORKERS', Math.min(availableParallelism(), 4));
const CACHE_TTL_MS = readPositiveInt('CACHE_TTL_MS', 10_000);

type UserRecord = {
  id: string;
  displayName: string;
  fetchedAt: string;
  fetchedByPid: number;
  fetchedByWorkerId: number | undefined;
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
    `[primary ${process.pid}] clustered users example listening on http://${HOST}:${PORT} with ${WORKERS} workers`,
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
  // getInstance() makes worker startup fail fast if the primary cannot create
  // or validate the shared namespace for this cache.
  const cache = await LRUCacheClustered.getInstance<string, UserRecord>({
    namespace: 'example-users',
    max: 1_000,
    ttl: CACHE_TTL_MS,
  });

  const loadUser = async (id: string): Promise<UserRecord> => {
    await sleep(250);
    const record = {
      id,
      displayName: `User ${id}`,
      fetchedAt: new Date().toISOString(),
      fetchedByPid: process.pid,
      fetchedByWorkerId: cluster.worker?.id,
    };
    console.log(`[worker ${cluster.worker?.id} pid=${process.pid}] loaded user:${id}`);
    return record;
  };

  // memoize() uses the cache's cluster-wide fetch dedup, so concurrent misses
  // for the same user collapse to one loader across all workers.
  const getUser = memoize(cache, loadUser, (id: string) => `user:${id}`, { ttl: CACHE_TTL_MS });

  const server = createServer((req, res) => {
    void (async () => {
      try {
        const url = new URL(req.url ?? '/', `http://${HOST}:${PORT}`);

        if (url.pathname === '/') {
          writeJson(res, 200, {
            example: 'clustered-users-server',
            routes: {
              user: `http://${HOST}:${PORT}/users/42`,
              refresh: `http://${HOST}:${PORT}/users/42?refresh=1`,
              stats: `http://${HOST}:${PORT}/stats`,
              clear: `http://${HOST}:${PORT}/clear`,
            },
            notes: [
              'Call /users/42 twice and compare servedBy.pid vs user.fetchedByPid.',
              'If they differ, one worker served a value loaded by another worker.',
              'Use ?refresh=1 to bypass the cached value and force a new fetch.',
            ],
          });
          return;
        }

        if (url.pathname === '/stats') {
          writeJson(res, 200, {
            servedBy: { pid: process.pid, workerId: cluster.worker?.id },
            stats: await cache.stats(),
            keys: await cache.keys(),
          });
          return;
        }

        if (url.pathname === '/clear') {
          await cache.clear();
          writeJson(res, 200, {
            cleared: true,
            servedBy: { pid: process.pid, workerId: cluster.worker?.id },
            stats: await cache.stats(),
          });
          return;
        }

        const match = url.pathname.match(/^\/users\/([^/]+)$/);
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
        const refresh = url.searchParams.get('refresh') === '1';
        const key = `user:${id}`;
        const user = refresh
          ? // forceRefresh starts a new leader fetch even if another value is
            // already cached for this key.
            await cache.fetch(key, () => loadUser(id), { ttl: CACHE_TTL_MS, forceRefresh: true })
          : await getUser(id);

        writeJson(res, 200, {
          servedBy: { pid: process.pid, workerId: cluster.worker?.id },
          cacheKey: key,
          refresh,
          wasLoadedByAnotherWorker: user.fetchedByPid !== process.pid,
          user,
          stats: await cache.stats(),
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
