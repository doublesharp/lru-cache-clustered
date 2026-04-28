import test from 'node:test';
import assert from 'node:assert/strict';
import { caches, handleRequest, stats } from '../src/primary.ts';
import { SOURCE, type Request } from '../src/messages.ts';

// Each iteration generates a fresh namespace; without clearing the full
// registry the caches/stats Maps accumulate ~NUM_RUNS entries per test (and
// across the 8 tests in this file). That accumulation reproducibly OOMs V8's
// internal NumberDictionary on long runs. Resetting per iteration matches the
// pattern in ipc.fuzz.test.ts.
function resetState() {
  caches.clear();
  stats.clear();
}

const NUM_RUNS = Number(process.env.FUZZ_RUNS ?? 200);

// See ipc.fuzz.test.ts for context: fast-check's per-run state accumulates
// across many iterations and reproducibly hits V8's NumberDictionary
// capacity cap. This file uses the same hand-rolled, seeded approach so
// behavior across the fuzz suite is consistent.

function dispatch(ns: string, op: string, extra: object = {}) {
  return handleRequest({
    id: 'r',
    namespace: ns,
    source: SOURCE,
    op,
    ...extra,
  } as Request);
}

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

function randInt(min: number, max: number): number {
  return Math.floor(rand() * (max - min + 1)) + min;
}
function randStr(maxLen = 16): string {
  const len = randInt(1, maxLen);
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let out = '';
  for (let i = 0; i < len; i++) out += chars[Math.floor(rand() * chars.length)];
  return out;
}
function randKey(): string | number {
  return rand() < 0.5 ? randStr(16) : randInt(-1_000_000, 1_000_000);
}
function randValue(): string | number | boolean {
  const c = rand();
  if (c < 0.34) return randStr(32);
  if (c < 0.67) return randInt(-1_000_000, 1_000_000);
  return rand() < 0.5;
}
function randEntries(maxLen: number): Array<[string | number, string | number | boolean]> {
  const len = randInt(0, maxLen);
  const out: Array<[string | number, string | number | boolean]> = [];
  for (let i = 0; i < len; i++) out.push([randKey(), randValue()]);
  return out;
}

void test('property: cache.size never exceeds cap', () => {
  for (let i = 0; i < NUM_RUNS; i++) {
    const cap = randInt(1, 50);
    const entries = randEntries(200);
    const ns = `prop-cap-${cap}-${i}`;
    resetState();
    dispatch(ns, 'init', { options: { max: cap } });
    for (const [k, v] of entries) dispatch(ns, 'set', { key: k, value: v });
    const size = (dispatch(ns, 'size') as { value: number }).value;
    assert.ok(size <= cap, `size ${size} > cap ${cap}`);
  }
});

void test('property: set then immediate get returns same value (within cap)', () => {
  for (let i = 0; i < NUM_RUNS; i++) {
    const key = randKey();
    const value = randValue();
    const cap = randInt(1, 100);
    const ns = `prop-rt-${cap}-${i}`;
    resetState();
    dispatch(ns, 'init', { options: { max: cap } });
    dispatch(ns, 'set', { key, value });
    const got = (dispatch(ns, 'get', { key }) as { value: unknown }).value;
    assert.deepEqual(got, value);
  }
});

void test('property: has(k) iff get(k) defined (no undefined values stored)', () => {
  for (let i = 0; i < NUM_RUNS; i++) {
    const entries = randEntries(50);
    if (entries.length === 0) continue;
    const ns = `prop-has-${i}`;
    resetState();
    dispatch(ns, 'init', { options: { max: 100 } });
    for (const [k, v] of entries) dispatch(ns, 'set', { key: k, value: v });
    for (const [k] of entries) {
      const has = (dispatch(ns, 'has', { key: k }) as { value: boolean }).value;
      const got = (dispatch(ns, 'get', { key: k }) as { value: unknown }).value;
      assert.equal(has, got !== undefined);
    }
  }
});

void test('property: clear empties the cache', () => {
  for (let i = 0; i < NUM_RUNS; i++) {
    const entries = randEntries(100);
    const ns = `prop-clear-${i}`;
    resetState();
    dispatch(ns, 'init', { options: { max: 200 } });
    for (const [k, v] of entries) dispatch(ns, 'set', { key: k, value: v });
    dispatch(ns, 'clear');
    assert.equal((dispatch(ns, 'size') as { value: number }).value, 0);
    assert.deepEqual((dispatch(ns, 'keys') as { value: unknown[] }).value, []);
  }
});

void test('property: mGet equivalent to map(get)', () => {
  for (let i = 0; i < NUM_RUNS; i++) {
    const seed = randEntries(50);
    const queryLen = randInt(0, 30);
    const queryKeys: Array<string | number> = [];
    for (let j = 0; j < queryLen; j++) queryKeys.push(randKey());

    const ns = `prop-mget-${i}`;
    resetState();
    dispatch(ns, 'init', { options: { max: 200 } });
    for (const [k, v] of seed) dispatch(ns, 'set', { key: k, value: v });

    const viaMget = (
      dispatch(ns, 'mGet', { keys: queryKeys }) as {
        value: Array<[unknown, unknown]>;
      }
    ).value;
    const viaMap = queryKeys.map((k) => [k, (dispatch(ns, 'get', { key: k }) as { value: unknown }).value]);

    assert.deepEqual(viaMget, viaMap);
  }
});

void test('property: mDelete removes all listed keys', () => {
  for (let i = 0; i < NUM_RUNS; i++) {
    const entries = randEntries(50);
    if (entries.length === 0) continue;
    const ns = `prop-mdel-${i}`;
    resetState();
    dispatch(ns, 'init', { options: { max: 200 } });
    for (const [k, v] of entries) dispatch(ns, 'set', { key: k, value: v });
    const keys = entries.map(([k]) => k);
    dispatch(ns, 'mDelete', { keys });
    for (const k of keys) {
      const has = (dispatch(ns, 'has', { key: k }) as { value: boolean }).value;
      assert.equal(has, false);
    }
  }
});

void test('property: incr/decr arithmetic round-trip', () => {
  for (let i = 0; i < NUM_RUNS; i++) {
    const key = randKey();
    const len = randInt(0, 20);
    const deltas: number[] = [];
    for (let j = 0; j < len; j++) deltas.push(randInt(-1000, 1000));

    const ns = `prop-incr-${i}`;
    resetState();
    dispatch(ns, 'init', { options: { max: 10 } });
    let expected = 0;
    for (const d of deltas) {
      if (d >= 0) expected = (dispatch(ns, 'incr', { key, amount: d }) as { value: number }).value;
      else expected = (dispatch(ns, 'decr', { key, amount: -d }) as { value: number }).value;
    }
    const final = (dispatch(ns, 'get', { key }) as { value: unknown }).value;
    if (deltas.length > 0) assert.equal(final, expected);
  }
});

void test('property: max(newCap) shrinks size to <= newCap', () => {
  for (let i = 0; i < NUM_RUNS; i++) {
    const initialCap = randInt(5, 30);
    const newCap = randInt(1, 5);
    const entries = randEntries(50);
    if (entries.length < 5) continue;

    const ns = `prop-max-${initialCap}-${newCap}-${i}`;
    resetState();
    dispatch(ns, 'init', { options: { max: initialCap } });
    for (const [k, v] of entries) dispatch(ns, 'set', { key: k, value: v });
    dispatch(ns, 'max', { value: newCap });
    const size = (dispatch(ns, 'size') as { value: number }).value;
    assert.ok(size <= newCap, `after max=${newCap}, size=${size}`);
  }
});
