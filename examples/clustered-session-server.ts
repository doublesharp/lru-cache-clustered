import cluster from 'node:cluster';
import { createServer, type ServerResponse } from 'node:http';
import { availableParallelism } from 'node:os';
import { fileURLToPath } from 'node:url';
import { LRUCacheClustered } from '../src/index.ts';

const ENTRYPOINT = fileURLToPath(import.meta.url);
const HOST = '127.0.0.1';
const PORT = readPositiveInt('PORT', 3002);
const WORKERS = readPositiveInt('WORKERS', Math.min(availableParallelism(), 4));
const SESSION_TTL_MS = readPositiveInt('SESSION_TTL_MS', 30_000);

type SessionRecord = {
  sessionId: string;
  userId: string;
  cartCount: number;
  createdAt: string;
  updatedAt: string;
  updatedByPid: number;
  updatedByWorkerId: number | undefined;
};

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
    `[primary ${process.pid}] clustered session example listening on http://${HOST}:${PORT} with ${WORKERS} workers`,
  );

  for (let i = 0; i < WORKERS; i += 1) {
    cluster.fork();
  }

  cluster.on('online', (worker) => {
    console.log(`[primary ${process.pid}] worker ${worker.id} online (pid=${worker.process.pid})`);
  });
}

async function startWorker(): Promise<void> {
  // Session state is created once in the primary-owned cache and then read or
  // updated by any worker that handles subsequent requests.
  const cache = await LRUCacheClustered.getInstance<string, SessionRecord>({
    namespace: 'example-sessions',
    max: 10_000,
    ttl: SESSION_TTL_MS,
  });

  const server = createServer((req, res) => {
    void (async () => {
      try {
        const url = new URL(req.url ?? '/', `http://${HOST}:${PORT}`);

        if (url.pathname === '/') {
          writeJson(res, 200, {
            example: 'clustered-session-server',
            routes: {
              login: `http://${HOST}:${PORT}/login?sid=s1&user=ada`,
              get: `http://${HOST}:${PORT}/session?sid=s1`,
              touch: `http://${HOST}:${PORT}/touch?sid=s1&cart=3`,
              ttl: `http://${HOST}:${PORT}/ttl?sid=s1`,
              logout: `http://${HOST}:${PORT}/logout?sid=s1`,
              stats: `http://${HOST}:${PORT}/stats`,
            },
            notes: [
              'Login on one request, then fetch the session again and compare servedBy.pid vs session.updatedByPid.',
              'If they differ, the session was created or updated by another worker and shared through the cache.',
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

        const sessionId = requireParam(url, 'sid');
        const key = `session:${sessionId}`;

        if (url.pathname === '/login') {
          const now = new Date().toISOString();
          const userId = requireParam(url, 'user');
          const session: SessionRecord = {
            sessionId,
            userId,
            cartCount: 0,
            createdAt: now,
            updatedAt: now,
            updatedByPid: process.pid,
            updatedByWorkerId: cluster.worker?.id,
          };
          // A plain set() is enough here because we want the latest session
          // write to win regardless of which worker handled the request.
          await cache.set(key, session, { ttl: SESSION_TTL_MS });
          writeJson(res, 200, {
            action: 'login',
            servedBy: { pid: process.pid, workerId: cluster.worker?.id },
            session,
            ttlMs: await cache.getRemainingTTL(key),
          });
          return;
        }

        if (url.pathname === '/session') {
          const session = await cache.get(key);
          if (!session) {
            writeJson(res, 404, { error: 'session_not_found', sessionId });
            return;
          }
          writeJson(res, 200, {
            servedBy: { pid: process.pid, workerId: cluster.worker?.id },
            session,
            ttlMs: await cache.getRemainingTTL(key),
          });
          return;
        }

        if (url.pathname === '/touch') {
          const existing = await cache.get(key);
          if (!existing) {
            writeJson(res, 404, { error: 'session_not_found', sessionId });
            return;
          }
          const cartCount = readPositiveIntFromValue(url.searchParams.get('cart'), existing.cartCount);
          const session: SessionRecord = {
            ...existing,
            cartCount,
            updatedAt: new Date().toISOString(),
            updatedByPid: process.pid,
            updatedByWorkerId: cluster.worker?.id,
          };
          // Rewriting the session through the shared cache makes the update
          // immediately visible to other workers serving the same user.
          await cache.set(key, session, { ttl: SESSION_TTL_MS });
          writeJson(res, 200, {
            action: 'touch',
            servedBy: { pid: process.pid, workerId: cluster.worker?.id },
            session,
            ttlMs: await cache.getRemainingTTL(key),
          });
          return;
        }

        if (url.pathname === '/ttl') {
          writeJson(res, 200, {
            servedBy: { pid: process.pid, workerId: cluster.worker?.id },
            sessionId,
            ttlMs: await cache.getRemainingTTL(key),
          });
          return;
        }

        if (url.pathname === '/logout') {
          writeJson(res, 200, {
            action: 'logout',
            servedBy: { pid: process.pid, workerId: cluster.worker?.id },
            deleted: await cache.delete(key),
          });
          return;
        }

        writeJson(res, 404, { error: 'not_found' });
      } catch (error) {
        writeError(res, error);
      }
    })();
  });

  server.listen(PORT, HOST, () => {
    console.log(`[worker ${cluster.worker?.id} pid=${process.pid}] http://${HOST}:${PORT}`);
  });
}

function readPositiveIntFromValue(raw: string | null, fallback: number): number {
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

if (cluster.isPrimary) {
  startPrimary();
} else {
  await startWorker();
}
