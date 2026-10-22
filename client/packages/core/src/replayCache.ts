// Replays pending mutations onto a query's server store incrementally between
// notifies.
//
// `Reactor._applyOptimisticUpdates` is a left fold over the sorted pending
// mutations, starting from the query's own server store: each mutation that has
// not been processed yet goes through `store.transact`, and that step depends
// on the store it is given (update/create steps are dropped for entities the
// store lacks, lookup refs resolve against it). So the fold can't be shared
// between queries, but it can be resumed: when the list replayed last time is,
// entry for entry, a prefix of the list to replay now, over the same server
// result, folding only the new tail onto the last output gives exactly the
// store a full replay would.
//
// "Entry for entry" means the same key and a mutation with the same effect on
// the fold: the same object, or the copy `transact-ok` makes when it stamps a
// `tx-id` (same `tx-steps` array) that is applied, or skipped, exactly as
// before. The client deletes a mutation on rollback, error and cleanup, so
// those fail the prefix check and the caller replays in full. Any doubt
// replays in full: the error is always to do more work, never to serve a stale
// store.

type Mutation = {
  'tx-steps': unknown;
  'tx-id'?: number;
};

export type MutationEntry = [string, Mutation];

export type Replayed<Store, AttrsStore> = {
  store: Store;
  attrsStore: AttrsStore;
};

/** The parts of a query's `querySubs` result the replay starts from. */
export type ReplayBase<Store, AttrsStore> = {
  store: Store;
  attrsStore: AttrsStore;
  processedTxId?: number;
};

export type ReplayCacheEntry<Store, AttrsStore> = {
  /** The server result replayed onto; its identity stands for the base store's. */
  result: ReplayBase<Store, AttrsStore>;
  entries: MutationEntry[];
  out: Replayed<Store, AttrsStore>;
};

export type ReplayCache = Map<string, ReplayCacheEntry<any, any>>;

export type ApplyMutations<Store, AttrsStore> = (
  store: Store,
  attrsStore: AttrsStore,
  entries: MutationEntry[],
  processedTxId?: number,
) => Replayed<Store, AttrsStore>;

/**
 * The optimistic store for query `hash`: `result`'s store with `entries`
 * applied by `apply`. It resumes from the last replay cached for `hash` when
 * that replay is a prefix of this one over the same `result`, and replays in
 * full otherwise. The cache keeps one replay per hash while it has pending
 * mutations.
 */
export function replayIncrementally<Store, AttrsStore>(
  cache: ReplayCache,
  hash: string,
  result: ReplayBase<Store, AttrsStore>,
  entries: MutationEntry[],
  apply: ApplyMutations<Store, AttrsStore>,
): Replayed<Store, AttrsStore> {
  const { store, attrsStore, processedTxId } = result;
  const prev = cache.get(hash);
  let out: Replayed<Store, AttrsStore>;
  if (
    prev &&
    prev.result === result &&
    isPrefix(prev.entries, entries, processedTxId)
  ) {
    out =
      prev.entries.length === entries.length
        ? prev.out
        : apply(
            prev.out.store,
            prev.out.attrsStore,
            entries.slice(prev.entries.length),
            processedTxId,
          );
  } else {
    out = apply(store, attrsStore, entries, processedTxId);
  }
  if (entries.length) {
    cache.set(hash, { result, entries, out });
  } else {
    cache.delete(hash);
  }
  return out;
}

/**
 * True when `prefix` is the first `prefix.length` entries of `entries`, each
 * with the same key and the same effect on the fold under `processedTxId`.
 */
export function isPrefix(
  prefix: MutationEntry[],
  entries: MutationEntry[],
  processedTxId: number | undefined,
): boolean {
  if (prefix.length > entries.length) return false;
  for (let i = 0; i < prefix.length; i++) {
    if (
      prefix[i][0] !== entries[i][0] ||
      !sameEffect(prefix[i][1], entries[i][1], processedTxId)
    ) {
      return false;
    }
  }
  return true;
}

function sameEffect(
  a: Mutation,
  b: Mutation,
  processedTxId: number | undefined,
): boolean {
  if (a === b) return true;
  return (
    a['tx-steps'] === b['tx-steps'] &&
    isApplied(a, processedTxId) === isApplied(b, processedTxId)
  );
}

/**
 * The test `Reactor._applyOptimisticUpdates` makes before replaying a
 * mutation. Keep the two in step.
 */
export function isApplied(
  mut: Mutation,
  processedTxId: number | undefined,
): boolean {
  return (
    !mut['tx-id'] || Boolean(processedTxId && mut['tx-id'] > processedTxId)
  );
}
