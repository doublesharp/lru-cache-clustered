import test from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';
import { createIpcClient } from '../src/worker.ts';
import { SOURCE } from '../src/messages.ts';

const NUM_RUNS = Number(process.env.FUZZ_RUNS ?? 200);
const fcOpts = { numRuns: NUM_RUNS };

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

void test('property: arbitrary inbound messages never crash the worker', () => {
  fc.assert(
    fc.asyncProperty(fc.anything(), async (raw) => {
      const fake = makeFakeProcess();
      const client = createIpcClient({
        send: fake.send.bind(fake),
        on: fake.on.bind(fake),
      });
      const p = client.sendToPrimary({ namespace: 'fuzz', timeout: 25, failsafe: 'resolve' }, { op: 'get', key: 'k' });
      // Deliver arbitrary garbage; client must ignore non-matching shapes.
      try {
        fake.deliver(raw);
      } catch (e) {
        assert.fail(`deliver threw on ${JSON.stringify(raw)}: ${String(e)}`);
      }
      // Pending promise must still settle (resolve undefined on timeout).
      const result = await p;
      assert.equal(result, undefined);
    }),
    fcOpts,
  );
});

void test('property: foreign-source messages are ignored even with matching id', () => {
  fc.assert(
    fc.asyncProperty(fc.string({ minLength: 1 }), fc.string({ minLength: 1 }), async (foreignSource, value) => {
      fc.pre(foreignSource !== SOURCE);
      const fake = makeFakeProcess();
      const client = createIpcClient({
        send: fake.send.bind(fake),
        on: fake.on.bind(fake),
      });
      const p = client.sendToPrimary({ namespace: 'fuzz', timeout: 25, failsafe: 'resolve' }, { op: 'get', key: 'k' });
      const sent = fake.sent[0] as { id: string };
      // Right id, wrong source — must be ignored, request times out.
      fake.deliver({ id: sent.id, source: foreignSource, ok: true, value });
      const result = await p;
      assert.equal(result, undefined);
    }),
    fcOpts,
  );
});

void test('property: matching response with arbitrary value resolves cleanly', () => {
  fc.assert(
    fc.asyncProperty(fc.anything(), async (value) => {
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
    }),
    fcOpts,
  );
});

void test('property: matching error response with arbitrary string rejects', () => {
  fc.assert(
    fc.asyncProperty(fc.string(), async (errMsg) => {
      const fake = makeFakeProcess();
      const client = createIpcClient({
        send: fake.send.bind(fake),
        on: fake.on.bind(fake),
      });
      const p = client.sendToPrimary({ namespace: 'fuzz', timeout: 1000, failsafe: 'reject' }, { op: 'get', key: 'k' });
      const sent = fake.sent[0] as { id: string };
      fake.deliver({ id: sent.id, source: SOURCE, ok: false, error: errMsg });
      await assert.rejects(p);
    }),
    fcOpts,
  );
});

void test('property: stale id never delivers to a different request', () => {
  fc.assert(
    fc.asyncProperty(fc.string(), async (staleId) => {
      const fake = makeFakeProcess();
      const client = createIpcClient({
        send: fake.send.bind(fake),
        on: fake.on.bind(fake),
      });
      const p = client.sendToPrimary({ namespace: 'fuzz', timeout: 25, failsafe: 'resolve' }, { op: 'get', key: 'k' });
      const real = (fake.sent[0] as { id: string }).id;
      fc.pre(staleId !== real);
      // Garbage id must be ignored; in-flight request times out.
      fake.deliver({
        id: staleId,
        source: SOURCE,
        ok: true,
        value: 'wrong',
      });
      const result = await p;
      assert.equal(result, undefined);
    }),
    fcOpts,
  );
});
