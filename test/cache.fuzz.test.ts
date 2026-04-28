import test from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';
import { caches, handleRequest } from '../src/primary.ts';
import { SOURCE, type Request } from '../src/messages.ts';

const NUM_RUNS = Number(process.env.FUZZ_RUNS ?? 200);
const fcOpts = { numRuns: NUM_RUNS };

function dispatch(ns: string, op: string, extra: object = {}) {
  return handleRequest({
    id: 'r',
    namespace: ns,
    source: SOURCE,
    op,
    ...extra,
  } as Request);
}

const arbKey = fc.oneof(fc.string({ maxLength: 16 }), fc.integer());
const arbValue = fc.oneof(fc.string({ maxLength: 32 }), fc.integer(), fc.boolean());

void test('property: cache.size never exceeds cap', () => {
  fc.assert(
    fc.property(
      fc.integer({ min: 1, max: 50 }),
      fc.array(fc.tuple(arbKey, arbValue), { maxLength: 200 }),
      (cap, entries) => {
        const ns = `prop-cap-${cap}`;
        caches.delete(ns);
        dispatch(ns, 'init', { options: { max: cap } });
        for (const [k, v] of entries) dispatch(ns, 'set', { key: k, value: v });
        const size = (dispatch(ns, 'size') as { value: number }).value;
        assert.ok(size <= cap, `size ${size} > cap ${cap}`);
      },
    ),
    fcOpts,
  );
});

void test('property: set then immediate get returns same value (within cap)', () => {
  fc.assert(
    fc.property(arbKey, arbValue, fc.integer({ min: 1, max: 100 }), (key, value, cap) => {
      const ns = `prop-rt-${cap}`;
      caches.delete(ns);
      dispatch(ns, 'init', { options: { max: cap } });
      dispatch(ns, 'set', { key, value });
      const got = (dispatch(ns, 'get', { key }) as { value: unknown }).value;
      assert.deepEqual(got, value);
    }),
    fcOpts,
  );
});

void test('property: has(k) iff get(k) defined (no undefined values stored)', () => {
  fc.assert(
    fc.property(fc.array(fc.tuple(arbKey, arbValue), { minLength: 1, maxLength: 50 }), (entries) => {
      const ns = 'prop-has';
      caches.delete(ns);
      dispatch(ns, 'init', { options: { max: 100 } });
      for (const [k, v] of entries) dispatch(ns, 'set', { key: k, value: v });
      for (const [k] of entries) {
        const has = (dispatch(ns, 'has', { key: k }) as { value: boolean }).value;
        const got = (dispatch(ns, 'get', { key: k }) as { value: unknown }).value;
        assert.equal(has, got !== undefined);
      }
    }),
    fcOpts,
  );
});

void test('property: clear empties the cache', () => {
  fc.assert(
    fc.property(fc.array(fc.tuple(arbKey, arbValue), { maxLength: 100 }), (entries) => {
      const ns = 'prop-clear';
      caches.delete(ns);
      dispatch(ns, 'init', { options: { max: 200 } });
      for (const [k, v] of entries) dispatch(ns, 'set', { key: k, value: v });
      dispatch(ns, 'clear');
      assert.equal((dispatch(ns, 'size') as { value: number }).value, 0);
      assert.deepEqual((dispatch(ns, 'keys') as { value: unknown[] }).value, []);
    }),
    fcOpts,
  );
});

void test('property: mGet equivalent to map(get)', () => {
  fc.assert(
    fc.property(
      fc.array(fc.tuple(arbKey, arbValue), { maxLength: 50 }),
      fc.array(arbKey, { maxLength: 30 }),
      (seed, queryKeys) => {
        const ns = 'prop-mget';
        caches.delete(ns);
        dispatch(ns, 'init', { options: { max: 200 } });
        for (const [k, v] of seed) dispatch(ns, 'set', { key: k, value: v });

        const viaMget = (
          dispatch(ns, 'mGet', { keys: queryKeys }) as {
            value: Array<[unknown, unknown]>;
          }
        ).value;

        const viaMap = queryKeys.map((k) => [k, (dispatch(ns, 'get', { key: k }) as { value: unknown }).value]);

        assert.deepEqual(viaMget, viaMap);
      },
    ),
    fcOpts,
  );
});

void test('property: mDelete removes all listed keys', () => {
  fc.assert(
    fc.property(fc.array(fc.tuple(arbKey, arbValue), { minLength: 1, maxLength: 50 }), (entries) => {
      const ns = 'prop-mdel';
      caches.delete(ns);
      dispatch(ns, 'init', { options: { max: 200 } });
      for (const [k, v] of entries) dispatch(ns, 'set', { key: k, value: v });
      const keys = entries.map(([k]) => k);
      dispatch(ns, 'mDelete', { keys });
      for (const k of keys) {
        const has = (dispatch(ns, 'has', { key: k }) as { value: boolean }).value;
        assert.equal(has, false);
      }
    }),
    fcOpts,
  );
});

void test('property: incr/decr arithmetic round-trip', () => {
  fc.assert(
    fc.property(arbKey, fc.array(fc.integer({ min: -1000, max: 1000 }), { maxLength: 20 }), (key, deltas) => {
      const ns = 'prop-incr';
      caches.delete(ns);
      dispatch(ns, 'init', { options: { max: 10 } });
      let expected = 0;
      for (const d of deltas) {
        if (d >= 0) expected = (dispatch(ns, 'incr', { key, amount: d }) as { value: number }).value;
        else expected = (dispatch(ns, 'decr', { key, amount: -d }) as { value: number }).value;
      }
      const final = (dispatch(ns, 'get', { key }) as { value: unknown }).value;
      if (deltas.length > 0) assert.equal(final, expected);
    }),
    fcOpts,
  );
});

void test('property: max(newCap) shrinks size to <= newCap', () => {
  fc.assert(
    fc.property(
      fc.integer({ min: 5, max: 30 }),
      fc.integer({ min: 1, max: 5 }),
      fc.array(fc.tuple(arbKey, arbValue), { minLength: 5, maxLength: 50 }),
      (initialCap, newCap, entries) => {
        const ns = `prop-max-${initialCap}-${newCap}`;
        caches.delete(ns);
        dispatch(ns, 'init', { options: { max: initialCap } });
        for (const [k, v] of entries) dispatch(ns, 'set', { key: k, value: v });
        dispatch(ns, 'max', { value: newCap });
        const size = (dispatch(ns, 'size') as { value: number }).value;
        assert.ok(size <= newCap, `after max=${newCap}, size=${size}`);
      },
    ),
    fcOpts,
  );
});
