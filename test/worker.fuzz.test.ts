import test from 'node:test';
import assert from 'node:assert/strict';
import { createIpcClient } from '../src/worker.ts';
import { SOURCE } from '../src/messages.ts';

const NUM_RUNS = Number(process.env.FUZZ_RUNS ?? 200);

// See ipc.fuzz.test.ts for context: hand-rolled, seeded inputs to avoid
// fast-check's per-run state accumulation. Async properties become plain
// async for-loops with `await` per iteration.

function makeFakeProcess() {
  const sent: unknown[] = [];
  const listeners: Array<(msg: unknown) => void> = [];
  return {
    sent,
    listeners,
    send(msg: unknown) {
      sent.push(msg);
      return true;
    },
    on(_: 'message', cb: (msg: unknown) => void) {
      listeners.push(cb);
    },
    deliver(msg: unknown) {
      for (const l of listeners) l(msg);
    },
  };
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

function pick<T>(arr: readonly T[]): T {
  return arr[Math.floor(rand() * arr.length)] as T;
}
function randInt(min: number, max: number): number {
  return Math.floor(rand() * (max - min + 1)) + min;
}
function randStr(maxLen = 24): string {
  const len = randInt(1, maxLen);
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789-_';
  let out = '';
  for (let i = 0; i < len; i++) out += chars[Math.floor(rand() * chars.length)];
  return out;
}

const PRIMITIVES: readonly unknown[] = ['', 'a', 'hello', 0, 1, -1, 42, 3.14, true, false, null, undefined];
const SHAPED: readonly unknown[] = [
  [],
  {},
  [[]],
  [{}],
  [null],
  { a: 1 },
  { 0: 'x' },
  [1, 2, 3],
  { ok: true, value: 'mixed' },
];
function randAny(): unknown {
  return rand() < 0.7 ? pick(PRIMITIVES) : pick(SHAPED);
}

void test('property: arbitrary inbound messages never crash the worker', async () => {
  for (let i = 0; i < NUM_RUNS; i++) {
    const raw = randAny();
    const fake = makeFakeProcess();
    const client = createIpcClient({
      send: fake.send.bind(fake),
      on: fake.on.bind(fake),
    });
    const p = client.sendToPrimary({ namespace: 'fuzz', timeout: 25, failsafe: 'resolve' }, { op: 'get', key: 'k' });
    try {
      fake.deliver(raw);
    } catch (e) {
      assert.fail(`deliver threw: ${String(e)}`);
    }
    const result = await p;
    assert.equal(result, undefined);
  }
});

void test('property: foreign-source messages are ignored even with matching id', async () => {
  for (let i = 0; i < NUM_RUNS; i++) {
    let foreignSource = randStr();
    while (foreignSource === SOURCE) foreignSource = randStr();
    const value = randStr();

    const fake = makeFakeProcess();
    const client = createIpcClient({
      send: fake.send.bind(fake),
      on: fake.on.bind(fake),
    });
    const p = client.sendToPrimary({ namespace: 'fuzz', timeout: 25, failsafe: 'resolve' }, { op: 'get', key: 'k' });
    const sent = fake.sent[0] as { id: string };
    fake.deliver({ id: sent.id, source: foreignSource, ok: true, value });
    const result = await p;
    assert.equal(result, undefined);
  }
});

void test('property: matching response with arbitrary value resolves cleanly', async () => {
  for (let i = 0; i < NUM_RUNS; i++) {
    const value = randAny();
    const fake = makeFakeProcess();
    const client = createIpcClient({
      send: fake.send.bind(fake),
      on: fake.on.bind(fake),
    });
    const p = client.sendToPrimary({ namespace: 'fuzz', timeout: 1000, failsafe: 'reject' }, { op: 'get', key: 'k' });
    const sent = fake.sent[0] as { id: string };
    fake.deliver({ id: sent.id, source: SOURCE, ok: true, value });
    const result = await p;
    assert.deepEqual(result, value);
  }
});

void test('property: matching error response with arbitrary string rejects', async () => {
  for (let i = 0; i < NUM_RUNS; i++) {
    const errMsg = rand() < 0.5 ? '' : randStr(64);
    const fake = makeFakeProcess();
    const client = createIpcClient({
      send: fake.send.bind(fake),
      on: fake.on.bind(fake),
    });
    const p = client.sendToPrimary({ namespace: 'fuzz', timeout: 1000, failsafe: 'reject' }, { op: 'get', key: 'k' });
    const sent = fake.sent[0] as { id: string };
    // Wire format: structured error payload (`{ name, message, ... }`).
    fake.deliver({
      id: sent.id,
      source: SOURCE,
      ok: false,
      error: { name: 'Error', message: errMsg },
    });
    await assert.rejects(p);
  }
});

void test('property: stale id never delivers to a different request', async () => {
  for (let i = 0; i < NUM_RUNS; i++) {
    const fake = makeFakeProcess();
    const client = createIpcClient({
      send: fake.send.bind(fake),
      on: fake.on.bind(fake),
    });
    const p = client.sendToPrimary({ namespace: 'fuzz', timeout: 25, failsafe: 'resolve' }, { op: 'get', key: 'k' });
    const real = (fake.sent[0] as { id: string }).id;
    let staleId = randStr();
    while (staleId === real) staleId = randStr();
    fake.deliver({ id: staleId, source: SOURCE, ok: true, value: 'wrong' });
    const result = await p;
    assert.equal(result, undefined);
  }
});
