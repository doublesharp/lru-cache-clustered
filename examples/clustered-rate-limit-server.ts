import cluster from 'node:cluster';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { availableParallelism } from 'node:os';
import { fileURLToPath } from 'node:url';
import { LRUCacheClustered } from '../src/index.ts';

const ENTRYPOINT = fileURLToPath(import.meta.url);
const HOST = '127.0.0.1';
const PORT = readPositiveInt('PORT', 3001);
const WORKERS = readPositiveInt('WORKERS', Math.min(availableParallelism(), 4));
const WINDOW_MS = readPositiveInt('WINDOW_MS', 15_000);
const LIMIT = readPositiveInt('LIMIT', 5);

function readPositiveInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function writeJson(res: ServerResponse, statusCode: number, body: unknown): void {
  res.writeHead(statusCode, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body, null, 2));
}

function writeError(res: ServerResponse, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  writeJson(res, 500, { error: 'internal_error', message });
}

function pickClientId(req: IncomingMessage, url: URL): string {
  const explicit = url.searchParams.get('client')?.trim();
  if (explicit) return explicit;

  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string') {
    const first = forwarded.split(',')[0]?.trim();
    if (first) return first;
  }
  if (Array.isArray(forwarded)) {
    const first = forwarded[0]?.split(',')[0]?.trim();
    if (first) return first;
  }

  return req.socket.remoteAddress ?? 'anonymous';
}

function startPrimary(): void {
  cluster.setupPrimary({
    exec: ENTRYPOINT,
    execArgv: ['--import', 'tsx'],
  });

  console.log(
    `[primary ${process.pid}] clustered rate-limit example listening on http://${HOST}:${PORT} with ${WORKERS} workers`,
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
  const cache = await LRUCacheClustered.getInstance<string, number>({
    namespace: 'example-rate-limit',
    max: 10_000,
    ttl: WINDOW_MS,
  });

  const server = createServer((req, res) => {
    void (async () => {
      try {
        const url = new URL(req.url ?? '/', `http://${HOST}:${PORT}`);

        if (url.pathname === '/') {
          writeJson(res, 200, {
            example: 'clustered-rate-limit-server',
            routes: {
              check: `http://${HOST}:${PORT}/check?client=alice`,
              reset: `http://${HOST}:${PORT}/reset?client=alice`,
              stats: `http://${HOST}:${PORT}/stats`,
            },
            config: { limit: LIMIT, windowMs: WINDOW_MS },
            notes: [
              'The same client key is shared across every worker.',
              'Once a key is created, incr() keeps its original TTL running.',
              'Hit /check more than the limit before the window expires to see a 429.',
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

        const clientId = pickClientId(req, url);
        const key = `rate:${clientId}`;

        if (url.pathname === '/reset') {
          writeJson(res, 200, {
            clientId,
            deleted: await cache.delete(key),
            servedBy: { pid: process.pid, workerId: cluster.worker?.id },
            stats: await cache.stats(),
          });
          return;
        }

        if (url.pathname !== '/check') {
          writeJson(res, 404, { error: 'not_found' });
          return;
        }

        const count = await cache.incr(key, 1, { ttl: WINDOW_MS });
        const resetInMs = await cache.getRemainingTTL(key);
        const allowed = count <= LIMIT;

        writeJson(res, allowed ? 200 : 429, {
          servedBy: { pid: process.pid, workerId: cluster.worker?.id },
          clientId,
          key,
          count,
          limit: LIMIT,
          allowed,
          remaining: Math.max(LIMIT - count, 0),
          resetInMs,
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
