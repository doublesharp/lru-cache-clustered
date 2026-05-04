import test from 'node:test';
import assert from 'node:assert/strict';
import { createIpcClient, getDefaultClient } from '../src/worker.ts';
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

void test('sendToPrimary rejects and cleans up when process.send throws', async () => {
  const listeners: Array<(msg: unknown) => void> = [];
  const client = createIpcClient({
    send() {
      throw new Error('channel closed');
    },
    on(_: 'message', cb: (msg: unknown) => void) {
      listeners.push(cb);
    },
  });

  await assert.rejects(
    client.sendToPrimary({ namespace: 'n', timeout: 1000, failsafe: 'reject' }, { op: 'get', key: 'k' }),
    /channel closed/,
  );

  assert.equal(listeners.length, 1);
  assert.doesNotThrow(() => listeners[0]?.({ id: '1', source: SOURCE, ok: true, value: 'late' }));
});

void test('sendToPrimary rejects on backpressure when failsafe=reject', async () => {
  const client = createIpcClient({
    // proc.send returning false signals IPC channel backpressure; the
    // message is dropped and no response will ever arrive.
    send() {
      return false;
    },
    on() {},
  });

  await assert.rejects(
    client.sendToPrimary({ namespace: 'n', timeout: 1000, failsafe: 'reject' }, { op: 'get', key: 'k' }),
    /IPC backpressure/,
  );
});

void test('sendToPrimary resolves undefined on backpressure when failsafe=resolve', async () => {
  const client = createIpcClient({
    send() {
      return false;
    },
    on() {},
  });

  const result = await client.sendToPrimary(
    { namespace: 'n', timeout: 1000, failsafe: 'resolve' },
    { op: 'get', key: 'k' },
  );
  assert.equal(result, undefined);
});

void test('sendToPrimary wraps non-Error process.send throws', async () => {
  const client = createIpcClient({
    send() {
      // eslint-disable-next-line @typescript-eslint/only-throw-error
      throw 'channel closed';
    },
    on() {},
  });

  await assert.rejects(
    client.sendToPrimary({ namespace: 'n', timeout: 1000, failsafe: 'reject' }, { op: 'get', key: 'k' }),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.equal(err.message, 'channel closed');
      return true;
    },
  );
});

void test('sendToPrimary ignores response with unknown id', async () => {
  const fake = makeFakeProcess();
  const client = createIpcClient({ send: fake.send.bind(fake), on: fake.on.bind(fake) });
  const p = client.sendToPrimary({ namespace: 'n', timeout: 25, failsafe: 'resolve' }, { op: 'get', key: 'k' });
  // Deliver a response with the wrong id; sendToPrimary should ignore it and time out.
  fake.deliver({ id: 'unknown-id', source: SOURCE, ok: true, value: 'ignored' });
  assert.equal(await p, undefined);
});

void test('isOurResponse rejects messages missing the ok discriminant', async () => {
  const fake = makeFakeProcess();
  const client = createIpcClient({ send: fake.send.bind(fake), on: fake.on.bind(fake) });
  const p = client.sendToPrimary({ namespace: 'n', timeout: 25, failsafe: 'resolve' }, { op: 'get', key: 'k' });
  const sent = fake.sent[0] as { id: string };
  // Deliver a malformed message: matching id and source but no `ok` boolean.
  // Without the typeof-boolean guard, the callback would try deserializeError(undefined)
  // and throw out of the message listener.
  fake.deliver({ id: sent.id, source: SOURCE } as unknown as Response);
  // sendToPrimary should still time out cleanly with no callback invoked.
  assert.equal(await p, undefined);
});

void test('isOurResponse rejects ok=false messages with malformed error payload', async () => {
  const fake = makeFakeProcess();
  const client = createIpcClient({ send: fake.send.bind(fake), on: fake.on.bind(fake) });
  const p = client.sendToPrimary({ namespace: 'n', timeout: 25, failsafe: 'resolve' }, { op: 'get', key: 'k' });
  const sent = fake.sent[0] as { id: string };
  // Deliver an ok=false message with no error payload. Without the
  // error-shape guard, deserializeError(undefined) would throw at
  // payload.message inside the message listener and crash the worker.
  fake.deliver({ id: sent.id, source: SOURCE, ok: false } as unknown as Response);
  fake.deliver({ id: sent.id, source: SOURCE, ok: false, error: 'not-an-object' } as unknown as Response);
  fake.deliver({
    id: sent.id,
    source: SOURCE,
    ok: false,
    error: { message: 'no-name' },
  } as unknown as Response);
  // None of the malformed messages reach the callback; sendToPrimary times out.
  assert.equal(await p, undefined);
});

void test('getDefaultClient throws when process.send is unavailable (primary mode)', () => {
  // eslint-disable-next-line @typescript-eslint/unbound-method
  const originalSend = process.send;
  // process.send is undefined in primary mode; tests run in primary, so this
  // is the natural state, but be explicit.
  (process as { send?: unknown }).send = undefined;
  try {
    assert.throws(() => getDefaultClient(), /not a cluster worker/);
  } finally {
    (process as { send?: unknown }).send = originalSend;
  }
});

void test('sendToPrimaryWithMeta exposes the version from the response', async () => {
  const { createIpcClient } = await import('../src/worker.ts');
  const sent: unknown[] = [];
  let resolveResponse: (raw: unknown) => void = () => {};
  const proc = {
    send(msg: unknown) {
      sent.push(msg);
      return true;
    },
    on(_e: 'message', cb: (msg: unknown) => void) {
      resolveResponse = cb;
    },
  };
  const client = createIpcClient(proc);
  const p = client.sendToPrimaryWithMeta<number>(
    { namespace: 'test', timeout: 1000, failsafe: 'reject' },
    { op: 'get', key: 'a' },
  );
  // Drive the response back manually
  const id = (sent[0] as { id: string }).id;
  resolveResponse({ id, source: 'lcfcap', ok: true, value: 42, version: 7 });
  const r = await p;
  assert.equal(r.value, 42);
  assert.equal(r.version, 7);
});

void test('sendToPrimaryWithMeta on timeout with failsafe=resolve returns version=0', async () => {
  const { createIpcClient } = await import('../src/worker.ts');
  const proc = {
    send: (_msg: unknown) => true,
    on: (_e: 'message', _cb: (msg: unknown) => void) => {},
  };
  const client = createIpcClient(proc);
  const r = await client.sendToPrimaryWithMeta<number>(
    { namespace: 'test', timeout: 5, failsafe: 'resolve' },
    { op: 'get', key: 'a' },
  );
  assert.equal(r.value, undefined);
  assert.equal(r.version, 0);
});

void test('getDefaultClient lazily creates and caches a real client when process.send exists', () => {
  // eslint-disable-next-line @typescript-eslint/unbound-method
  const originalSend = process.send;
  const sent: unknown[] = [];
  // Simulate worker mode: install a fake process.send long enough to construct.
  (process as { send?: (msg: unknown) => boolean }).send = (msg: unknown) => {
    sent.push(msg);
    return true;
  };
  try {
    const first = getDefaultClient();
    const second = getDefaultClient();
    assert.equal(first, second, 'should cache the singleton');
    // Fire a no-response request to confirm send is wired up; let it time out.
    void first.sendToPrimary({ namespace: 'n', timeout: 1, failsafe: 'resolve' }, { op: 'get', key: 'k' });
    assert.equal(sent.length, 1);
    assert.equal((sent[0] as { source: string }).source, SOURCE);
  } finally {
    (process as { send?: unknown }).send = originalSend;
  }
});
