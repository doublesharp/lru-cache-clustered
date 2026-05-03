import cluster from 'node:cluster';
import { createServer, type ServerResponse } from 'node:http';
import { availableParallelism } from 'node:os';
import { fileURLToPath } from 'node:url';
import { LRUCacheClustered } from '../src/index.ts';

const ENTRYPOINT = fileURLToPath(import.meta.url);
const HOST = '127.0.0.1';
const PORT = readPositiveInt('PORT', 3003);
const WORKERS = readPositiveInt('WORKERS', Math.min(availableParallelism(), 4));
const IDEMPOTENCY_TTL_MS = readPositiveInt('IDEMPOTENCY_TTL_MS', 30_000);

type JobRecord = {
  key: string;
  state: 'processing' | 'completed';
  startedAt: string;
  completedAt?: string;
  ownerPid: number;
  ownerWorkerId: number | undefined;
  result?: string;
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

function requireParam(url: URL, name: string): string {
  const value = url.searchParams.get(name)?.trim();
  if (!value) throw new Error(`Missing required query parameter: ${name}`);
  return value;
}

function startPrimary(): void {
  cluster.setupPrimary({
    exec: ENTRYPOINT,
    execArgv: ['--import', 'tsx'],
  });

  console.log(
    `[primary ${process.pid}] clustered idempotency example listening on http://${HOST}:${PORT} with ${WORKERS} workers`,
  );

  for (let i = 0; i < WORKERS; i += 1) {
    cluster.fork();
  }

  cluster.on('online', (worker) => {
    console.log(`[primary ${process.pid}] worker ${worker.id} online (pid=${worker.process.pid})`);
  });
}

async function startWorker(): Promise<void> {
  // All workers compete on the same namespace, which lets the primary act as
  // the single arbiter for "has this request key already been claimed?".
  const cache = await LRUCacheClustered.getInstance<string, JobRecord>({
    namespace: 'example-idempotency',
    max: 10_000,
    ttl: IDEMPOTENCY_TTL_MS,
  });

  const server = createServer((req, res) => {
    void (async () => {
      try {
        const url = new URL(req.url ?? '/', `http://${HOST}:${PORT}`);

        if (url.pathname === '/') {
          writeJson(res, 200, {
            example: 'clustered-idempotency-server',
            routes: {
              submit: `http://${HOST}:${PORT}/submit?key=checkout-123`,
              status: `http://${HOST}:${PORT}/status?key=checkout-123`,
              reset: `http://${HOST}:${PORT}/reset?key=checkout-123`,
              stats: `http://${HOST}:${PORT}/stats`,
            },
            notes: [
              'Fire /submit for the same key from multiple terminals at the same time.',
              'Only one worker will claim the key; the rest will reuse the in-flight or completed record.',
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

        const idempotencyKey = requireParam(url, 'key');
        const key = `idem:${idempotencyKey}`;

        if (url.pathname === '/status') {
          const record = await cache.get(key);
          if (!record) {
            writeJson(res, 404, { error: 'job_not_found', key: idempotencyKey });
            return;
          }
          writeJson(res, 200, {
            servedBy: { pid: process.pid, workerId: cluster.worker?.id },
            record,
            ttlMs: await cache.getRemainingTTL(key),
          });
          return;
        }

        if (url.pathname === '/reset') {
          writeJson(res, 200, {
            servedBy: { pid: process.pid, workerId: cluster.worker?.id },
            deleted: await cache.delete(key),
          });
          return;
        }

        if (url.pathname !== '/submit') {
          writeJson(res, 404, { error: 'not_found' });
          return;
        }

        const now = new Date().toISOString();
        const claim: JobRecord = {
          key: idempotencyKey,
          state: 'processing',
          startedAt: now,
          ownerPid: process.pid,
          ownerWorkerId: cluster.worker?.id,
        };

        // setIfAbsent() is the cluster-safe claim primitive: only one worker
        // can install the first record for a given idempotency key.
        const claimed = await cache.setIfAbsent(key, claim, { ttl: IDEMPOTENCY_TTL_MS });
        if (!claimed) {
          writeJson(res, 200, {
            duplicate: true,
            servedBy: { pid: process.pid, workerId: cluster.worker?.id },
            record: await cache.get(key),
            ttlMs: await cache.getRemainingTTL(key),
          });
          return;
        }

        console.log(`[worker ${cluster.worker?.id} pid=${process.pid}] claimed ${idempotencyKey}`);
        await sleep(400);

        const completed: JobRecord = {
          ...claim,
          state: 'completed',
          completedAt: new Date().toISOString(),
          result: `processed by pid ${process.pid}`,
        };

        // After the winning worker finishes, replace the in-flight marker with
        // the completed result so duplicate callers can reuse it.
        await cache.set(key, completed, { ttl: IDEMPOTENCY_TTL_MS });

        writeJson(res, 201, {
          duplicate: false,
          servedBy: { pid: process.pid, workerId: cluster.worker?.id },
          record: completed,
          ttlMs: await cache.getRemainingTTL(key),
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
