import test from 'node:test';
import assert from 'node:assert/strict';
import { caches, handleRequest, stats } from '../src/primary.ts';
import { SOURCE, type Request } from '../src/messages.ts';

// Each iteration generates a fresh `namespace`, which creates a new cache.
// Without cleanup the registry grows unbounded over hundreds of iterations
// and across the three fuzz files run in one process.
function resetState() {
  caches.clear();
  stats.clear();
}

const NUM_RUNS = Number(process.env.FUZZ_RUNS ?? 500);

// Originally written with fast-check (`fc.assert(fc.property(...))`), but that
// reproducibly OOM'd V8's internal NumberDictionary hash table on this suite,
// even after constraining inputs to primitives and clearing per-iteration
// state. Switched to hand-rolled randomized inputs: deterministic per seed,
// no per-iteration framework state, no surprises. We trade automatic
// shrinking on failure for reliable runs in CI.

function isResponseShape(v: unknown): v is { id?: unknown; source?: unknown; ok: boolean } {
  return typeof v === 'object' && v !== null && typeof (v as { ok?: unknown }).ok === 'boolean';
}

// Mulberry32 — small, fast PRNG with no allocations per call.
function mulberry32(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SEED = Number(process.env.FUZZ_SEED ?? 0xc0ffee);
const rand = mulberry32(SEED);

function pick<T>(arr: readonly T[]): T {
  return arr[Math.floor(rand() * arr.length)] as T;
}
function maybe<T>(p: number, gen: () => T): T | undefined {
  return rand() < p ? gen() : undefined;
}
function randInt(min: number, max: number): number {
  return Math.floor(rand() * (max - min + 1)) + min;
}
function randStr(maxLen = 12): string {
  const len = randInt(0, maxLen);
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789-_';
  let out = '';
  for (let i = 0; i < len; i++) out += chars[Math.floor(rand() * chars.length)];
  return out;
}

const PRIMITIVES: readonly unknown[] = [
  '',
  'a',
  'hello',
  randStr(8),
  0,
  1,
  -1,
  42,
  3.14,
  -0.5,
  Number.MAX_SAFE_INTEGER,
  true,
  false,
  null,
  undefined,
];
const SHAPED: readonly unknown[] = [[], {}, [[]], [{}], [null], { a: 1 }, { 0: 'x' }, [1, 2, 3]];
function randAny(): unknown {
  return rand() < 0.7 ? pick(PRIMITIVES) : pick(SHAPED);
}

const KNOWN_OPS = [
  'init',
  'get',
  'set',
  'delete',
  'has',
  'peek',
  'clear',
  'purgeStale',
  'mGet',
  'mSet',
  'mDelete',
  'keys',
  'values',
  'entries',
  'dump',
  'size',
  'incr',
  'decr',
  'allowStale',
  'max',
  'ttl',
];

function randNearMissRequest(): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (rand() < 0.9) out.id = pick([randStr(), randInt(-100, 100), undefined]);
  if (rand() < 0.9) out.namespace = pick([randStr(), undefined, null]);
  if (rand() < 0.9) out.source = pick([SOURCE, randStr(), undefined]);
  if (rand() < 0.95) out.op = pick([...KNOWN_OPS, randStr(), undefined]);
  if (rand() < 0.6) out.key = randAny();
  if (rand() < 0.6) out.value = randAny();
  if (rand() < 0.4) {
    const len = randInt(0, 5);
    const arr: unknown[] = [];
    for (let i = 0; i < len; i++) arr.push(randAny());
    out.keys = arr;
  }
  if (rand() < 0.4) {
    const len = randInt(0, 5);
    const arr: Array<[unknown, unknown]> = [];
    for (let i = 0; i < len; i++) arr.push([randAny(), randAny()]);
    out.entries = arr;
  }
  if (rand() < 0.3) {
    out.options = {
      max: maybe(0.7, () => randInt(1, 100)),
      ttl: maybe(0.5, () => randInt(0, 60_000)),
      allowStale: maybe(0.5, () => rand() < 0.5),
    };
  }
  if (rand() < 0.5) out.amount = randInt(-100, 100);
  if (rand() < 0.4) out.ttl = randInt(0, 60_000);
  return out;
}

// Safe stringify — failure messages must not themselves crash on weird inputs.
function safeStr(v: unknown): string {
  try {
    return JSON.stringify(v) ?? String(v);
  } catch {
    return Object.prototype.toString.call(v);
  }
}

void test('property: handleRequest never throws on arbitrary input', () => {
  for (let i = 0; i < NUM_RUNS; i++) {
    resetState();
    const raw = randAny();
    let result: unknown;
    try {
      result = handleRequest(raw as Request);
    } catch (e) {
      assert.fail(`handleRequest threw on ${safeStr(raw)}: ${String(e)}`);
    }
    assert.ok(isResponseShape(result), `expected response shape, got ${safeStr(result)}`);
  }
});

void test('property: handleRequest returns valid Response on near-miss inputs', () => {
  for (let i = 0; i < NUM_RUNS; i++) {
    resetState();
    const req = randNearMissRequest();
    let result: unknown;
    try {
      result = handleRequest(req as unknown as Request);
    } catch (e) {
      assert.fail(`handleRequest threw on ${safeStr(req)}: ${String(e)}`);
    }
    assert.ok(isResponseShape(result));
    const r = result as {
      ok: boolean;
      value?: unknown;
      error?: { name?: unknown; message?: unknown };
    };
    if (r.ok) assert.ok('value' in r, 'ok response missing value');
    else {
      assert.ok(r.error && typeof r.error === 'object', 'err missing error');
      assert.equal(typeof r.error.message, 'string');
      assert.equal(typeof r.error.name, 'string');
    }
  }
});

// Build a JSON string of bounded depth without fast-check — same intent
// (parse arbitrary JSON, hand to handleRequest, expect a valid response),
// just without the framework retention.
function randJsonValue(depth: number): unknown {
  if (depth <= 0) return pick(PRIMITIVES);
  const choice = rand();
  if (choice < 0.4) return pick(PRIMITIVES);
  if (choice < 0.7) {
    const len = randInt(0, 4);
    const arr: unknown[] = [];
    for (let i = 0; i < len; i++) arr.push(randJsonValue(depth - 1));
    return arr;
  }
  const len = randInt(0, 4);
  const obj: Record<string, unknown> = {};
  for (let i = 0; i < len; i++) obj[randStr(6)] = randJsonValue(depth - 1);
  return obj;
}

void test('property: handleRequest with deeply nested junk still terminates', () => {
  for (let i = 0; i < NUM_RUNS; i++) {
    resetState();
    const value = randJsonValue(3);
    let jsonStr: string;
    try {
      jsonStr = JSON.stringify(value) ?? 'null';
    } catch {
      continue;
    }
    const parsed: unknown = JSON.parse(jsonStr);
    let result: unknown;
    try {
      result = handleRequest(parsed as Request);
    } catch (e) {
      assert.fail(`handleRequest threw on JSON input: ${String(e)}`);
    }
    assert.ok(isResponseShape(result));
  }
});
