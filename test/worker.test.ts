import test from 'node:test';
import assert from 'node:assert/strict';
import { createIpcClient } from '../src/worker.ts';
import { SOURCE, type Response } from '../src/messages.ts';

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
    deliver(msg: Response) {
      for (const l of listeners) l(msg);
    },
  };
}

void test('sendToPrimary resolves with value on matching response', async () => {
  const fake = makeFakeProcess();
  const client = createIpcClient({ send: fake.send.bind(fake), on: fake.on.bind(fake) });
  const p = client.sendToPrimary({ namespace: 'n', timeout: 1000, failsafe: 'resolve' }, { op: 'get', key: 'k' });
  const sent = fake.sent[0] as { id: string; source: string };
  assert.equal(sent.source, SOURCE);
  fake.deliver({ id: sent.id, source: SOURCE, ok: true, value: 'hello' });
  assert.equal(await p, 'hello');
});

void test('sendToPrimary rejects on ok=false', async () => {
  const fake = makeFakeProcess();
  const client = createIpcClient({ send: fake.send.bind(fake), on: fake.on.bind(fake) });
  const p = client.sendToPrimary({ namespace: 'n', timeout: 1000, failsafe: 'resolve' }, { op: 'get', key: 'k' });
  const sent = fake.sent[0] as { id: string };
  fake.deliver({ id: sent.id, source: SOURCE, ok: false, error: { name: 'Error', message: 'boom' } });
  await assert.rejects(p, /boom/);
});

void test('sendToPrimary rejects with reconstructed Error preserving name and code', async () => {
  const fake = makeFakeProcess();
  const client = createIpcClient({ send: fake.send.bind(fake), on: fake.on.bind(fake) });
  const p = client.sendToPrimary({ namespace: 'n', timeout: 1000, failsafe: 'resolve' }, { op: 'get', key: 'k' });
  const sent = fake.sent[0] as { id: string };
  fake.deliver({
    id: sent.id,
    source: SOURCE,
    ok: false,
    error: { name: 'CustomErr', message: 'oops', code: 'E_CUSTOM' },
  });
  await assert.rejects(p, (err: unknown) => {
    assert.ok(err instanceof Error);
    assert.equal(err.name, 'CustomErr');
    assert.equal(err.message, 'oops');
    assert.equal((err as { code?: unknown }).code, 'E_CUSTOM');
    return true;
  });
});

void test('sendToPrimary rejects with chained cause', async () => {
  const fake = makeFakeProcess();
  const client = createIpcClient({ send: fake.send.bind(fake), on: fake.on.bind(fake) });
  const p = client.sendToPrimary({ namespace: 'n', timeout: 1000, failsafe: 'resolve' }, { op: 'get', key: 'k' });
  const sent = fake.sent[0] as { id: string };
  fake.deliver({
    id: sent.id,
    source: SOURCE,
    ok: false,
    error: { name: 'Outer', message: 'top', cause: { name: 'Inner', message: 'root' } },
  });
  await assert.rejects(p, (err: unknown) => {
    assert.ok(err instanceof Error);
    const cause = (err as { cause?: unknown }).cause;
    assert.ok(cause instanceof Error);
    assert.equal(cause.name, 'Inner');
    assert.equal(cause.message, 'root');
    return true;
  });
});

void test('sendToPrimary ignores responses with foreign source', async () => {
  const fake = makeFakeProcess();
  const client = createIpcClient({ send: fake.send.bind(fake), on: fake.on.bind(fake) });
  const p = client.sendToPrimary({ namespace: 'n', timeout: 50, failsafe: 'resolve' }, { op: 'get', key: 'k' });
  const sent = fake.sent[0] as { id: string };
  fake.deliver({ id: sent.id, source: 'other-package' as never, ok: true, value: 'wrong' } as never);
  // Should still time out because foreign source was ignored
  assert.equal(await p, undefined);
});

void test('sendToPrimary timeout with failsafe=resolve resolves undefined', async () => {
  const fake = makeFakeProcess();
  const client = createIpcClient({ send: fake.send.bind(fake), on: fake.on.bind(fake) });
  const p = client.sendToPrimary({ namespace: 'n', timeout: 25, failsafe: 'resolve' }, { op: 'get', key: 'k' });
  assert.equal(await p, undefined);
});

void test('sendToPrimary timeout with failsafe=reject rejects', async () => {
  const fake = makeFakeProcess();
  const client = createIpcClient({ send: fake.send.bind(fake), on: fake.on.bind(fake) });
  const p = client.sendToPrimary({ namespace: 'n', timeout: 25, failsafe: 'reject' }, { op: 'get', key: 'k' });
  await assert.rejects(p, /timeout/i);
});

void test('sendToPrimary ignores response with unknown id', async () => {
  const fake = makeFakeProcess();
  const client = createIpcClient({ send: fake.send.bind(fake), on: fake.on.bind(fake) });
  const p = client.sendToPrimary({ namespace: 'n', timeout: 25, failsafe: 'resolve' }, { op: 'get', key: 'k' });
  // Deliver a response with the wrong id; sendToPrimary should ignore it and time out.
  fake.deliver({ id: 'unknown-id', source: SOURCE, ok: true, value: 'ignored' });
  assert.equal(await p, undefined);
});
