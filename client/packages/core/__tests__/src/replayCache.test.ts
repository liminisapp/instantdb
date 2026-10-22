// https://www.npmjs.com/package/fake-indexeddb
import 'fake-indexeddb/auto';
import { describe, expect, it, vi } from 'vitest';
import { setTimeout as sleep } from 'timers/promises';

import IndexedDBStorage from '../../src/IndexedDBStorage';
import Reactor from '../../src/Reactor';
import { tx, lookup } from '../../src/instatx';
import instaql from '../../src/instaql';
import { AttrsStoreClass, createStore } from '../../src/store';
import {
  isApplied,
  isPrefix,
  replayIncrementally,
  type MutationEntry,
} from '../../src/replayCache';
import uuid from '../../src/utils/id';
import { weakHash } from '../../src';

// A recompute resumes a query's optimistic replay from the last one when only
// new pending mutations were added since. The Reactor tests run each scenario
// twice, with `_incrementalReplay` on and off, and check that every subscriber
// received the identical sequence of payloads both ways, and that what a
// recompute gives equals a fresh full replay.

// ---------------------------------------------------------------------------
// Fixtures

/** Deterministic uuids, so two reactors built from one spec share ids. */
function idFactory(prefix) {
  let n = 0;
  return () => {
    const hex = (n++).toString(16).padStart(12, '0');
    return `${prefix.padEnd(8, '0').slice(0, 8)}-0000-4000-8000-${hex}`;
  };
}

const nextAttrId = idFactory('a0000000');

function idAttr(etype) {
  return {
    id: nextAttrId(),
    'forward-identity': [nextAttrId(), etype, 'id'],
    'value-type': 'blob',
    cardinality: 'one',
    'unique?': true,
    'index?': false,
    'primary?': true,
  };
}

function blobAttr(etype, label, extra = {}) {
  return {
    id: nextAttrId(),
    'forward-identity': [nextAttrId(), etype, label],
    'value-type': 'blob',
    cardinality: 'one',
    'unique?': false,
    'index?': false,
    ...extra,
  };
}

function refAttr([fwdEtype, fwdLabel], [revEtype, revLabel], cardinality) {
  return {
    id: nextAttrId(),
    'forward-identity': [nextAttrId(), fwdEtype, fwdLabel],
    'reverse-identity': [nextAttrId(), revEtype, revLabel],
    'value-type': 'ref',
    cardinality,
    'unique?': false,
    'index?': false,
  };
}

const ATTRS = [
  idAttr('A'),
  blobAttr('A', 'x'),
  blobAttr('A', 'y'),
  blobAttr('A', 'z', { 'unique?': true, 'index?': true }),
  idAttr('B'),
  blobAttr('B', 'name'),
  refAttr(['A', 'bs'], ['B', 'as'], 'many'),
];

function attrOf(etype, label) {
  const attr = ATTRS.find(
    (a) =>
      a['forward-identity'][1] === etype && a['forward-identity'][2] === label,
  );
  if (!attr) throw new Error(`no attr ${etype}.${label}`);
  return attr;
}

function entityTriples(etype, id, values = {}) {
  return [
    [id, attrOf(etype, 'id').id, id, 1],
    ...Object.entries(values).map(([label, v]) => [
      id,
      attrOf(etype, label).id,
      v,
      1,
    ]),
  ];
}

const eid = idFactory('e0000000');
const [A0, A1, A2, B0, B1] = Array.from({ length: 5 }, eid);

const TRIPLES = [
  ...entityTriples('A', A0, { x: 0, y: 0, z: 'z0' }),
  ...entityTriples('A', A1, { x: 1, y: 1, z: 'z1' }),
  ...entityTriples('A', A2, { x: 2, y: 2, z: 'z2' }),
  ...entityTriples('B', B0, { name: 'b0' }),
  ...entityTriples('B', B1, { name: 'b1' }),
  [A0, attrOf('A', 'bs').id, B0, 1],
];

/** `TRIPLES` restricted to the entities in `keep`, and the links between them. */
function subset(keep) {
  const k = new Set(keep);
  return TRIPLES.filter(
    ([e, , v]) =>
      k.has(e) &&
      (typeof v !== 'string' || !v.startsWith('e0000000') || k.has(v)),
  );
}

const QUERIES = {
  wildA: { A: {} },
  fieldsX: { A: { $: { fields: ['x'] } } },
  nested: { A: { $: { fields: ['y'] }, bs: { $: { fields: ['name'] } } } },
  reverse: { B: { as: {} } },
  byLookupAttr: { A: { $: { where: { z: 'k' }, fields: ['y'] } } },
  pinned: { A: { $: { where: { id: A0 } }, bs: {} } },
};

// ---------------------------------------------------------------------------
// A real Reactor, with every delivery and replay recorded

async function waitForLoaded(reactor) {
  await reactor.querySubs.waitForMetaToLoad();
  await reactor.kv.waitForMetaToLoad();
  await reactor.kv.waitForKeyToLoad('pendingMutations');
  await reactor.querySubs.flush();
  await reactor.kv.flush();
}

class Harness {
  reactor;
  /** Every payload delivered to each hash's subscriber. */
  deliveries = new Map();
  /** The server triples each hash was subscribed with, for a refresh. */
  serverTriples = new Map();
  unsubscribes = new Map();
  notifyOne;
  applyOptimisticUpdates;

  static async create({ incremental }) {
    const h = new Harness();
    const reactor = new Reactor({ appId: uuid() });
    reactor._initStorage(IndexedDBStorage);
    reactor._setAttrs(ATTRS);
    reactor._incrementalReplay = incremental;
    h.reactor = reactor;
    await waitForLoaded(reactor);
    h.notifyOne = vi.spyOn(reactor, 'notifyOne');
    h.applyOptimisticUpdates = vi.spyOn(reactor, '_applyOptimisticUpdates');
    return h;
  }

  /** Subscribes `q`, and delivers it a server result of `triples`. */
  async subscribe(q, triples = TRIPLES) {
    const delivered: any[] = [];
    const unsubscribe = this.reactor.subscribeQuery(q, (data) =>
      delivered.push(structuredClone(data)),
    );
    const hash = weakHash(q);
    this.unsubscribes.set(hash, unsubscribe);
    this.deliveries.set(hash, delivered);
    this.serverTriples.set(hash, triples);
    this.reactor._handleReceive(0, {
      op: 'add-query-ok',
      q,
      'processed-tx-id': 0,
      result: [
        {
          data: {
            'datalog-result': { 'join-rows': [triples.map((t) => [...t])] },
          },
          'child-nodes': [],
        },
      ],
    });
    await this.flush();
    return hash;
  }

  write(chunks) {
    this.reactor.pushTx(chunks).catch(() => {});
  }

  /** A local write of raw tx-steps, as `pushOps` receives them. */
  writeSteps(steps) {
    this.reactor.pushOps(steps).catch(() => {});
  }

  /** Pending mutation event ids, in the order the Reactor applies them. */
  pendingEventIds() {
    return [...this.reactor._pendingMutations().entries()]
      .sort(([ka, a], [kb, b]) =>
        (a.order || 0) === (b.order || 0)
          ? ka < kb
            ? -1
            : ka > kb
              ? 1
              : 0
          : (a.order || 0) - (b.order || 0),
      )
      .map(([k]) => k);
  }

  /** The server rejects, or the client times out, the `index`th pending mutation. */
  reject(index, status = 'error') {
    const eventId = this.pendingEventIds()[index];
    if (!eventId) return;
    // The write's promise already resolved as `enqueued`, so the reactor
    // logs the failure for want of a listener.
    const error = console.error;
    console.error = () => {};
    try {
      this.reactor._handleMutationError(status, eventId, {
        message: 'rejected in test',
      });
    } finally {
      console.error = error;
    }
  }

  /** The server confirms the `index`th pending mutation as `txId`. */
  confirm(index, txId) {
    const eventId = this.pendingEventIds()[index];
    if (!eventId) return;
    this.reactor._handleReceive(0, {
      op: 'transact-ok',
      'client-event-id': eventId,
      'tx-id': txId,
    });
  }

  /** A `refresh-ok` that recomputes `hashes` from their server triples at `processedTxId`. */
  refresh(hashes, processedTxId) {
    this.reactor._handleReceive(0, {
      op: 'refresh-ok',
      'processed-tx-id': processedTxId,
      computations: hashes.map((hash) => ({
        'instaql-query': this.reactor.querySubs.currentValue[hash].q,
        'instaql-result': [
          {
            data: {
              'datalog-result': {
                'join-rows': [this.serverTriples.get(hash).map((t) => [...t])],
              },
            },
            'child-nodes': [],
          },
        ],
      })),
    });
  }

  /**
   * Waits until the reactor is quiet. A notify is delivered through
   * `querySubs.waitForKeyToLoad(hash).then(...)`, which can resolve after
   * a single tick when storage is slow, so wait for the persisted objects to
   * flush and for the notify count to hold still across several ticks.
   */
  async flush() {
    let last = -1;
    let quietTicks = 0;
    for (let i = 0; i < 100 && quietTicks < 3; i++) {
      await this.reactor.querySubs.flush();
      await this.reactor.kv.flush();
      await sleep(0);
      const n = this.notifyOne.mock.calls.length;
      quietTicks = n === last ? quietTicks + 1 : 0;
      last = n;
    }
  }

  /**
   * Recomputes every query, so each holds a replay. A notify scoped to what a
   * write touches would otherwise leave some queries without one.
   */
  recomputeAll(hashes) {
    for (const hash of hashes) this.reactor.notifyOne(hash);
  }

  resetCounts() {
    this.notifyOne.mockClear();
    this.applyOptimisticUpdates.mockClear();
  }

  /** Mutations passed to `_applyOptimisticUpdates` since the last reset. */
  mutationApplications() {
    return this.applyOptimisticUpdates.mock.calls.reduce(
      (n, call) => n + call[2].length,
      0,
    );
  }

  lastDelivered(hash) {
    return this.deliveries.get(hash).at(-1);
  }

  /** What a recompute of `hash` gives now. */
  current(hash) {
    return structuredClone(this.reactor.dataForQuery(hash).data);
  }

  /** A fresh evaluation of `hash` over its store with every pending mutation applied. */
  truth(hash) {
    const { q, result } = this.reactor.querySubs.currentValue[hash];
    const muts = this.reactor._rewriteMutationsSorted(
      result.attrsStore,
      this.reactor._pendingMutations(),
    );
    const { store, attrsStore } =
      Reactor.prototype._applyOptimisticUpdates.call(
        this.reactor,
        result.store,
        result.attrsStore,
        muts,
        result.processedTxId,
      );
    return structuredClone(
      instaql(
        {
          store,
          attrsStore,
          pageInfo: result.pageInfo,
          aggregate: result.aggregate,
        },
        q,
      ),
    );
  }
}

async function start(incremental, queries, triplesFor = (_name) => TRIPLES) {
  const h = await Harness.create({ incremental });
  const hash = {};
  for (const [name, q] of Object.entries(queries)) {
    hash[name] = await h.subscribe(q, triplesFor(name));
  }
  h.resetCounts();
  return { h, hash };
}

/**
 * Runs `act` with the incremental replay on and off from the same start, and
 * asserts that every subscriber saw the identical payload sequence both ways,
 * and that each query's recompute equals a fresh full replay.
 */
async function bothWays(
  act,
  queries: Record<string, any> = QUERIES,
  triplesFor?,
) {
  const run = async (incremental) => {
    const r = await start(incremental, queries, triplesFor);
    await act(r);
    await r.h.flush();
    return r;
  };
  const on = await run(true);
  const off = await run(false);
  for (const name of Object.keys(queries)) {
    expect(
      on.h.deliveries.get(on.hash[name]),
      `${name}: incremental deliveries differ from a full replay`,
    ).toEqual(off.h.deliveries.get(off.hash[name]));
    expect(
      on.h.current(on.hash[name]),
      `${name}: incremental data is not the true data`,
    ).toEqual(on.h.truth(on.hash[name]));
  }
  return { on, off };
}

// ---------------------------------------------------------------------------
// The module

describe('replayCache', () => {
  const mut = (steps: unknown = [], extra = {}) => ({
    'tx-steps': steps,
    ...extra,
  });
  const appendKeys = () =>
    vi.fn((store: string[], attrsStore, entries: MutationEntry[]) => ({
      store: [...store, ...entries.map(([k]) => k)],
      attrsStore,
    }));

  it('applies the whole list the first time, then only the new tail', () => {
    const cache = new Map();
    const apply = appendKeys();
    // A plain object stands for the query's server result.
    const result = { store: [], attrsStore: 'attrs' };
    const m1: MutationEntry = ['1', mut()];
    const m2: MutationEntry = ['2', mut()];

    expect(replayIncrementally(cache, 'h', result, [m1], apply).store).toEqual([
      '1',
    ]);
    expect(
      replayIncrementally(cache, 'h', result, [m1, m2], apply).store,
    ).toEqual(['1', '2']);
    expect(apply.mock.calls.map((c) => c[2].map(([k]) => k))).toEqual([
      ['1'],
      ['2'],
    ]);

    // Nothing new: the last output is reused, with no apply at all.
    const out = replayIncrementally(cache, 'h', result, [m1, m2], apply);
    expect(out.store).toEqual(['1', '2']);
    expect(apply).toHaveBeenCalledTimes(2);
  });

  it('replays in full on a new server result, a removed or replaced mutation, or a new order', () => {
    const cache = new Map();
    const apply = appendKeys();
    const m1: MutationEntry = ['1', mut(['s1'])];
    const m2: MutationEntry = ['2', mut(['s2'])];
    const result = { store: [], attrsStore: 'attrs' };
    replayIncrementally(cache, 'h', result, [m1, m2], apply);

    const cases: [string, object, MutationEntry[]][] = [
      ['a new server result', { ...result }, [m1, m2]],
      ['the first rolled back', result, [m2]],
      ['different steps under one key', result, [m1, ['2', mut(['other'])]]],
      ['a new order', result, [m2, m1]],
    ];
    for (const [name, base, entries] of cases) {
      replayIncrementally(cache, 'h', result, [m1, m2], apply);
      apply.mockClear();
      replayIncrementally(cache, 'h', base as any, entries, apply);
      expect(apply.mock.calls[0][2], name).toEqual(entries);
      expect(apply.mock.calls[0][0], name).toBe((base as any).store);
    }
  });

  it('keeps one replay per hash, and forgets one whose pending list is empty', () => {
    const cache = new Map();
    const apply = (store, attrsStore) => ({ store, attrsStore });
    const result = { store: {}, attrsStore: {} };
    replayIncrementally(cache, 'a', result, [['1', mut()]], apply);
    replayIncrementally(cache, 'b', result, [['1', mut()]], apply);
    replayIncrementally(cache, 'a', result, [['1', mut()]], apply);
    expect([...cache.keys()]).toEqual(['a', 'b']);
    replayIncrementally(cache, 'a', result, [], apply);
    expect([...cache.keys()]).toEqual(['b']);
  });

  it('isApplied matches _applyOptimisticUpdates at the processedTxId boundary', () => {
    expect(isApplied(mut(), undefined)).toBe(true);
    expect(isApplied(mut(), 5)).toBe(true);
    // Stamped: applied only while the result has not processed it.
    expect(isApplied(mut([], { 'tx-id': 6 }), 5)).toBe(true);
    expect(isApplied(mut([], { 'tx-id': 5 }), 5)).toBe(false);
    expect(isApplied(mut([], { 'tx-id': 4 }), 5)).toBe(false);
    expect(isApplied(mut([], { 'tx-id': 6 }), undefined)).toBe(false);
    expect(isApplied(mut([], { 'tx-id': 6 }), 0)).toBe(false);

    // Against the Reactor's own fold: a stamped write of x is visible exactly
    // when isApplied says it is replayed.
    const attrsStore = new AttrsStoreClass(
      Object.fromEntries(ATTRS.map((a) => [a.id, a])),
      null,
    );
    const store = createStore(attrsStore, TRIPLES, true, false);
    const reactor = new Reactor({ appId: uuid() });
    for (const txId of [undefined, 4, 5, 6]) {
      for (const processed of [undefined, 0, 5]) {
        const m = mut(
          [['add-triple', A0, attrOf('A', 'x').id, 99]],
          txId === undefined ? {} : { 'tx-id': txId },
        );
        const out = reactor._applyOptimisticUpdates(
          store,
          attrsStore,
          [['k', m]],
          processed,
        );
        const x = instaql(
          { store: out.store, attrsStore: out.attrsStore },
          {
            A: { $: { where: { id: A0 } } },
          },
        ).data.A[0].x;
        expect(x === 99, `tx-id ${txId}, processed ${processed}`).toBe(
          isApplied(m, processed),
        );
      }
    }
  });

  it('treats a confirmed copy as the same mutation only while it is applied, or skipped, as before', () => {
    const steps = ['s'];
    const pending: MutationEntry = ['1', mut(steps)];
    const above: MutationEntry = [
      '1',
      mut(steps, { 'tx-id': 9, confirmed: 1 }),
    ];
    const below: MutationEntry = [
      '1',
      mut(steps, { 'tx-id': 3, confirmed: 1 }),
    ];
    // processedTxId 5: tx-id 9 is still applied, tx-id 3 is now skipped.
    expect(isPrefix([pending], [above], 5)).toBe(true);
    expect(isPrefix([pending], [below], 5)).toBe(false);
    // No processedTxId: a stamped mutation is skipped, an unstamped one applied.
    expect(isPrefix([pending], [above], undefined)).toBe(false);
    expect(isPrefix([above], [below], undefined)).toBe(true);
    // Different steps are a different mutation, whatever the stamp.
    expect(
      isPrefix([pending], [['1', mut(['other'], { 'tx-id': 9 })]], 5),
    ).toBe(false);
    // A longer list is never a prefix of a shorter one.
    expect(isPrefix([pending, pending], [pending], 5)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The Reactor

const xOf = (payload, id) => payload.data.A.find((a) => a.id === id)?.x;

describe('incremental replay', () => {
  it('defaults on', () => {
    expect(new Reactor({ appId: uuid() })._incrementalReplay).toBe(true);
  });

  it('a prefix match applies each pending mutation once, not once per recompute of the backlog', async () => {
    const WRITES = 8;
    const { on, off } = await bothWays(
      async ({ h }) => {
        for (let i = 0; i < WRITES; i++) {
          h.write(tx.A[A0].update({ x: 10 + i }));
          await h.flush();
        }
      },
      { wildA: QUERIES.wildA },
    );
    expect(on.h.mutationApplications()).toBe(WRITES);
    expect(off.h.mutationApplications()).toBe((WRITES * (WRITES + 1)) / 2);
    expect(xOf(on.h.lastDelivered(on.hash.wildA), A0)).toBe(10 + WRITES - 1);
  });

  it('a recompute that finds the pending list unchanged reuses the last replay', async () => {
    const { h, hash } = await start(true, QUERIES);
    h.write(tx.A[A0].update({ x: 5 }));
    await h.flush();
    h.recomputeAll(Object.values(hash));
    h.resetCounts();
    // Another query's refresh moves the querySubs version, so dataForQuery recomputes.
    h.reactor.querySubs.updateInPlace(() => {});
    for (const name of Object.keys(QUERIES)) h.reactor.notifyOne(hash[name]);
    expect(h.applyOptimisticUpdates).not.toHaveBeenCalled();
    for (const name of Object.keys(QUERIES)) {
      expect(h.current(hash[name]), name).toEqual(h.truth(hash[name]));
    }
  });

  it('a rewritten list falls back to a full replay, and shows the write', async () => {
    const xAttr = attrOf('A', 'x');
    const localId = uuid();
    const { on, off } = await bothWays(
      async ({ h }) => {
        h.write(tx.A[A0].update({ y: 1 }));
        await h.flush();
        // A write made before the client knew `A.x`: its add-attr and triple
        // carry a local id, which _rewriteMutations maps to the server's.
        h.writeSteps([
          ['add-attr', { ...xAttr, id: localId }],
          ['add-triple', A0, localId, 42],
        ]);
        await h.flush();
        h.resetCounts();
        h.write(tx.A[A0].update({ y: 2 }));
        await h.flush();
      },
      { wildA: QUERIES.wildA },
    );
    // Every recompute after the rewrite replays all three, as with the cache off.
    expect(
      on.h.applyOptimisticUpdates.mock.calls.map((c) => c[2].length),
    ).toEqual(off.h.applyOptimisticUpdates.mock.calls.map((c) => c[2].length));
    expect(on.h.mutationApplications()).toBe(3);
    expect(
      on.h.lastDelivered(on.hash.wildA).data.A.find((a) => a.id === A0),
    ).toMatchObject({ x: 42, y: 2 });
  });

  it.each([
    [9, 5],
    [10, 0],
    [11, 0],
  ])(
    'a mutation confirmed as tx 10, after a refresh at %i, shows x = %i',
    async (processed, x) => {
      // The fixture's server triples never include the write, so x reads 5
      // only while the confirmed write is still replayed (tx-id > processed).
      const { on } = await bothWays(
        async ({ h, hash }) => {
          h.write(tx.A[A0].update({ x: 5 }));
          await h.flush();
          h.write(tx.A[A1].update({ x: 6 }));
          await h.flush();
          h.confirm(0, 10);
          h.refresh([hash.wildA], processed);
          await h.flush();
          h.write(tx.A[A2].update({ x: 7 }));
          await h.flush();
        },
        { wildA: QUERIES.wildA, fieldsX: QUERIES.fieldsX },
      );
      expect(xOf(on.h.current(on.hash.wildA), A0)).toBe(x);
      // fieldsX was not refreshed: its result never processed tx 10, so a stamped write is skipped.
      expect(xOf(on.h.current(on.hash.fieldsX), A0)).toBe(0);
    },
  );

  it('a rejected write in the middle of the list forces a full replay and rolls back', async () => {
    const { on } = await bothWays(async ({ h }) => {
      h.write(tx.A[A0].update({ x: 5 }));
      h.write(tx.A[A0].update({ y: 6 }));
      h.write(tx.A[A1].update({ x: 7 }));
      await h.flush();
      h.reject(0);
      await h.flush();
      // Now the third write: a timeout before any tx-id also rolls it back.
      h.reject(1, 'timeout');
    });
    expect(xOf(on.h.lastDelivered(on.hash.fieldsX), A0)).toBe(0);
    expect(xOf(on.h.lastDelivered(on.hash.fieldsX), A1)).toBe(1);
    expect(on.h.pendingEventIds()).toHaveLength(1);
  });

  it('a lookup that resolves in one query and not in another gives each its own answer', async () => {
    // `pinned` holds A0 only, `wildA` holds everything: A1 is unknown to the first.
    const triplesFor = (name) =>
      name === 'pinned' ? subset([A0, B0]) : TRIPLES;
    await bothWays(
      async ({ h }) => {
        h.write(tx.A[A1].update({ z: 'k' }));
        await h.flush();
        h.write(tx.A[lookup('z', 'k')].update({ y: 3 }));
        await h.flush();
        h.write(tx.A[A0].update({ x: 9 }));
        await h.flush();
        h.reject(0);
      },
      QUERIES,
      triplesFor,
    );
  });

  it('_cleanupQuery drops the query’s cached replay', async () => {
    const { h, hash } = await start(true, QUERIES);
    h.write(tx.A[A0].update({ x: 5 }));
    await h.flush();
    h.recomputeAll(Object.values(hash));
    expect(h.reactor._replayCache.has(hash.nested)).toBe(true);
    h.unsubscribes.get(hash.nested)();
    expect(h.reactor._replayCache.has(hash.nested)).toBe(false);
    expect(h.reactor._replayCache.has(hash.wildA)).toBe(true);
    // A later write still delivers the truth to the others.
    h.write(tx.A[A1].update({ x: 6 }));
    await h.flush();
    expect(h.current(hash.wildA)).toEqual(h.truth(hash.wildA));
  });

  it('updateUser drops every cached replay', async () => {
    const { h, hash } = await start(true, QUERIES);
    h.write(tx.A[A0].update({ x: 5 }));
    await h.flush();
    h.recomputeAll(Object.values(hash));
    expect(h.reactor._replayCache.size).toBe(Object.keys(QUERIES).length);
    const error = console.error;
    console.error = () => {};
    try {
      const done = h.reactor.updateUser({ id: uuid() }).catch(() => {});
      expect(h.reactor._replayCache.size).toBe(0);
      await done;
    } finally {
      console.error = error;
    }
  });

  it('drops a query’s replay once nothing is pending', async () => {
    const { h, hash } = await start(true, { wildA: QUERIES.wildA });
    h.write(tx.A[A0].update({ x: 5 }));
    await h.flush();
    expect(h.reactor._replayCache.has(hash.wildA)).toBe(true);
    h.reject(0);
    await h.flush();
    expect(h.reactor._replayCache.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Seeded fuzz

function mulberry32(seed) {
  let t = seed;
  return () => {
    t = (t + 0x6d2b79f5) | 0;
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('incremental replay, seeded fuzz', () => {
  it.each([2295, 77])(
    'matches a full replay after every step of 120 random writes, rejections, confirmations and refreshes (seed %i)',
    async (SEED) => {
      const run = async (incremental) => {
        const rand = mulberry32(SEED);
        const pick = (xs) => xs[Math.floor(rand() * xs.length)];
        const ids = idFactory('f0000000');
        const as = [A0, A1, A2];
        const bs = [B0, B1];
        const h = await Harness.create({ incremental });
        const hash = {};
        // Each query's store holds a random subset of the server's entities,
        // so update/create steps and lookup refs resolve differently per query.
        for (const [name, q] of Object.entries(QUERIES)) {
          const keep = [...as, ...bs].filter(
            (e) => rand() < 0.75 || (name === 'pinned' && e === A0),
          );
          hash[name] = await h.subscribe(q, subset(keep));
        }
        h.resetCounts();
        let txId = 100;
        let processed = 0;
        for (let step = 0; step < 120; step++) {
          const r = rand();
          if (r < 0.25)
            h.write(tx.A[pick(as)].update({ x: Math.floor(rand() * 4) }));
          else if (r < 0.35)
            h.write(tx.A[pick(as)].update({ y: Math.floor(rand() * 4) }));
          else if (r < 0.42)
            h.write(tx.B[pick(bs)].update({ name: pick(['b0', 'b1', 'n']) }));
          else if (r < 0.47) {
            const a = ids();
            as.push(a);
            h.write(tx.A[a].update({ x: 1, y: 1 }).link({ bs: pick(bs) }));
          } else if (r < 0.53) h.write(tx.A[pick(as)].link({ bs: pick(bs) }));
          else if (r < 0.57) h.write(tx.A[pick(as)].unlink({ bs: pick(bs) }));
          else if (r < 0.61)
            h.write(tx.A[pick(as)].update({ z: pick(['k', 'z1']) }));
          else if (r < 0.65)
            h.write(
              tx.A[lookup('z', 'k')].update({ y: Math.floor(rand() * 4) }),
            );
          else if (r < 0.67) h.write(tx.A[pick(as)].delete());
          else if (r < 0.77) {
            const pending = h.pendingEventIds().length;
            if (pending)
              h.reject(
                Math.floor(rand() * pending),
                pick(['error', 'timeout']),
              );
          } else if (r < 0.9) {
            const pending = h.pendingEventIds().length;
            if (pending) h.confirm(Math.floor(rand() * pending), ++txId);
          } else {
            // Some queries recompute on the server at a tx between what is
            // processed and what is confirmed.
            processed = Math.min(
              txId,
              Math.max(processed, 100 + Math.floor(rand() * (txId - 99))),
            );
            h.refresh(
              Object.values(hash).filter(() => rand() < 0.5),
              processed,
            );
          }
          await h.flush();
          for (const name of Object.keys(QUERIES)) {
            expect(
              h.current(hash[name]),
              `step ${step}, ${name}, incremental ${incremental}`,
            ).toEqual(h.truth(hash[name]));
          }
        }
        return { h, hash };
      };

      const on = await run(true);
      const off = await run(false);
      for (const name of Object.keys(QUERIES)) {
        expect(on.h.deliveries.get(on.hash[name]), name).toEqual(
          off.h.deliveries.get(off.hash[name]),
        );
      }
      expect(on.h.mutationApplications()).toBeLessThan(
        off.h.mutationApplications(),
      );
    },
    60_000,
  );
});
