import cluster from 'node:cluster';
import { createServer, type ServerResponse } from 'node:http';
import { availableParallelism } from 'node:os';
import { fileURLToPath } from 'node:url';
import { gunzipSync, gzipSync } from 'node:zlib';
import { LRUCacheClustered, wrap } from '../src/index.ts';

const ENTRYPOINT = fileURLToPath(import.meta.url);
const HOST = '127.0.0.1';
const PORT = readPositiveInt('PORT', 3004);
const WORKERS = readPositiveInt('WORKERS', Math.min(availableParallelism(), 4));
const DOCUMENT_TTL_MS = readPositiveInt('DOCUMENT_TTL_MS', 60_000);

type DocumentRecord = {
  id: string;
  title: string;
  body: string;
  tags: string[];
  storedAt: string;
  storedByPid: number;
  storedByWorkerId: number | undefined;
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

function createBody(kb: number): string {
  const seed = 'clustered-cache-demo ';
  return seed.repeat(Math.max(1, Math.floor((kb * 1024) / seed.length))).trim();
}

function startPrimary(): void {
  cluster.setupPrimary({
    exec: ENTRYPOINT,
    execArgv: ['--import', 'tsx'],
  });

  console.log(
    `[primary ${process.pid}] clustered compressed-documents example listening on http://${HOST}:${PORT} with ${WORKERS} workers`,
  );

  for (let i = 0; i < WORKERS; i += 1) {
    cluster.fork();
  }

  cluster.on('online', (worker) => {
    console.log(`[primary ${process.pid}] worker ${worker.id} online (pid=${worker.process.pid})`);
  });
}

async function startWorker(): Promise<void> {
  const rawCache = await LRUCacheClustered.getInstance<string, Buffer>({
    namespace: 'example-compressed-documents',
    max: 1_000,
    ttl: DOCUMENT_TTL_MS,
  });

  // The underlying clustered cache stores compressed Buffers on the primary.
  // wrap() lets handlers work with decoded JSON objects instead.
  const cache = wrap(rawCache, {
    encode: (value: DocumentRecord) => gzipSync(Buffer.from(JSON.stringify(value), 'utf8')),
    decode: (raw: Buffer) => JSON.parse(gunzipSync(raw).toString('utf8')) as DocumentRecord,
  });

  const server = createServer((req, res) => {
    void (async () => {
      try {
        const url = new URL(req.url ?? '/', `http://${HOST}:${PORT}`);

        if (url.pathname === '/') {
          writeJson(res, 200, {
            example: 'clustered-compressed-documents-server',
            routes: {
              store: `http://${HOST}:${PORT}/store?id=doc-1&kb=32`,
              get: `http://${HOST}:${PORT}/document?id=doc-1`,
              remove: `http://${HOST}:${PORT}/delete?id=doc-1`,
              stats: `http://${HOST}:${PORT}/stats`,
            },
            notes: [
              'Documents are stored in the primary as gzipped Buffers and decoded back on read.',
              'The response reports both the original JSON size and the compressed size.',
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

        const id = requireParam(url, 'id');
        const key = `doc:${id}`;

        if (url.pathname === '/delete') {
          writeJson(res, 200, {
            servedBy: { pid: process.pid, workerId: cluster.worker?.id },
            deleted: await cache.delete(key),
          });
          return;
        }

        if (url.pathname === '/store') {
          const kb = readPositiveIntFromValue(url.searchParams.get('kb'), 32);
          const record: DocumentRecord = {
            id,
            title: `Document ${id}`,
            body: createBody(kb),
            tags: ['cluster', 'cache', 'compression'],
            storedAt: new Date().toISOString(),
            storedByPid: process.pid,
            storedByWorkerId: cluster.worker?.id,
          };

          await cache.set(key, record, { ttl: DOCUMENT_TTL_MS });
          // Reading through rawCache shows the actual compressed payload size
          // stored in the primary process.
          const raw = await rawCache.get(key);
          const jsonBytes = Buffer.byteLength(JSON.stringify(record), 'utf8');
          const storedBytes = raw?.length ?? 0;

          writeJson(res, 200, {
            servedBy: { pid: process.pid, workerId: cluster.worker?.id },
            record: {
              id: record.id,
              title: record.title,
              tags: record.tags,
              storedAt: record.storedAt,
              storedByPid: record.storedByPid,
              storedByWorkerId: record.storedByWorkerId,
            },
            jsonBytes,
            storedBytes,
            compressionRatio: storedBytes === 0 ? 0 : Number((jsonBytes / storedBytes).toFixed(2)),
            ttlMs: await cache.getRemainingTTL(key),
          });
          return;
        }

        if (url.pathname === '/document') {
          const record = await cache.get(key);
          if (!record) {
            writeJson(res, 404, { error: 'document_not_found', id });
            return;
          }

          const raw = await rawCache.get(key);
          const jsonBytes = Buffer.byteLength(JSON.stringify(record), 'utf8');
          const storedBytes = raw?.length ?? 0;

          writeJson(res, 200, {
            servedBy: { pid: process.pid, workerId: cluster.worker?.id },
            record,
            jsonBytes,
            storedBytes,
            compressionRatio: storedBytes === 0 ? 0 : Number((jsonBytes / storedBytes).toFixed(2)),
            ttlMs: await cache.getRemainingTTL(key),
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
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

if (cluster.isPrimary) {
  startPrimary();
} else {
  await startWorker();
}
