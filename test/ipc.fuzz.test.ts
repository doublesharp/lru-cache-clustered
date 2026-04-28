import test from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';
import { handleRequest } from '../src/primary.ts';
import { SOURCE, type Request } from '../src/messages.ts';

const NUM_RUNS = Number(process.env.FUZZ_RUNS ?? 500);
const fcOpts = { numRuns: NUM_RUNS };

function isResponseShape(v: unknown): v is { id?: unknown; source?: unknown; ok: boolean } {
  return typeof v === 'object' && v !== null && typeof (v as { ok?: unknown }).ok === 'boolean';
}

void test('property: handleRequest never throws on arbitrary input', () => {
  fc.assert(
    fc.property(fc.anything(), (raw) => {
      let result: unknown;
      try {
        result = handleRequest(raw as Request);
      } catch (e) {
        assert.fail(`handleRequest threw on ${JSON.stringify(raw)}: ${String(e)}`);
      }
      assert.ok(isResponseShape(result), `expected response shape, got ${JSON.stringify(result)}`);
    }),
    fcOpts,
  );
});

const knownOps = [
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

const arbNearMissRequest = fc.record(
  {
    id: fc.oneof(fc.string(), fc.integer(), fc.constant(undefined)),
    namespace: fc.oneof(fc.string(), fc.constant(undefined), fc.constant(null)),
    source: fc.oneof(fc.constant(SOURCE), fc.string(), fc.constant(undefined)),
    op: fc.oneof(fc.constantFrom(...knownOps), fc.string(), fc.constant(undefined)),
    key: fc.option(fc.anything()),
    value: fc.option(fc.anything()),
    keys: fc.option(fc.array(fc.anything(), { maxLength: 5 })),
    entries: fc.option(fc.array(fc.tuple(fc.anything(), fc.anything()), { maxLength: 5 })),
    options: fc.option(
      fc.record(
        {
          max: fc.option(fc.integer()),
          ttl: fc.option(fc.integer()),
          allowStale: fc.option(fc.boolean()),
        },
        { requiredKeys: [] },
      ),
    ),
    amount: fc.option(fc.integer()),
    ttl: fc.option(fc.integer()),
  },
  { requiredKeys: [] },
);

void test('property: handleRequest returns valid Response on near-miss inputs', () => {
  fc.assert(
    fc.property(arbNearMissRequest, (req) => {
      let result: unknown;
      try {
        result = handleRequest(req as Request);
      } catch (e) {
        assert.fail(`handleRequest threw on ${JSON.stringify(req)}: ${String(e)}`);
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
    }),
    fcOpts,
  );
});

void test('property: handleRequest with deeply nested junk still terminates', () => {
  fc.assert(
    fc.property(fc.json({ depthSize: 'large' }), (jsonStr) => {
      const parsed: unknown = JSON.parse(jsonStr);
      let result: unknown;
      try {
        result = handleRequest(parsed as Request);
      } catch (e) {
        assert.fail(`handleRequest threw on JSON input: ${String(e)}`);
      }
      assert.ok(isResponseShape(result));
    }),
    fcOpts,
  );
});
