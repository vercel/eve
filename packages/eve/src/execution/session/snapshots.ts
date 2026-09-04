import { equalSnapshot } from "#execution/session/snapshot-equality.js";

import type {
  SnapshotRecordId,
  SnapshotRecordRef,
  SnapshotStreamRef,
} from "#execution/session/resources.js";
import { decodeStreamLocation, encodeStreamLocation } from "#execution/session/stream-location.js";
import {
  appendStreamRecords,
  readStreamRecord,
  streamTailIndex,
} from "#execution/session/stream-storage.js";

interface SnapshotWrite {
  readonly writeId: string;
}

type SnapshotEntry =
  | { readonly kind: "initialized" }
  | { readonly kind: "record"; readonly ref: SnapshotRecordRef };

export interface StoredSnapshot<Checkpoint> {
  readonly ref: SnapshotRecordRef;
  readonly checkpoint: Checkpoint;
}

function recordRef(ref: SnapshotStreamRef, writeId: string): SnapshotRecordRef {
  if (writeId.length === 0) throw new Error("Snapshot writes require a stable write identity.");
  const location = decodeStreamLocation(ref.id);
  return {
    id: encodeStreamLocation({
      runId: location.runId,
      namespace: `${location.namespace}.record.${encodeURIComponent(writeId)}`,
    }) as SnapshotRecordId,
  };
}

async function readHead(ref: SnapshotStreamRef): Promise<SnapshotEntry | undefined> {
  const index = await streamTailIndex(ref.id);
  return index === -1 ? undefined : readStreamRecord<SnapshotEntry>(ref.id, index);
}

export const sessionSnapshots = {
  async find<Checkpoint>(
    stream: SnapshotStreamRef,
    writeId: string,
  ): Promise<StoredSnapshot<Checkpoint> | undefined> {
    const ref = recordRef(stream, writeId);
    if ((await streamTailIndex(ref.id)) === -1) return undefined;
    return { ref, checkpoint: await sessionSnapshots.read<Checkpoint>(ref) };
  },
  async initialize(ref: SnapshotStreamRef): Promise<void> {
    if ((await readHead(ref)) === undefined) {
      await appendStreamRecords<SnapshotEntry>(ref.id, [{ kind: "initialized" }]);
    }
  },

  async latest<Checkpoint>(
    ref: SnapshotStreamRef,
  ): Promise<StoredSnapshot<Checkpoint> | undefined> {
    const head = await readHead(ref);
    if (head === undefined) throw new Error("Session snapshot storage has not been initialized.");
    if (head.kind === "initialized") return undefined;
    return { ref: head.ref, checkpoint: await sessionSnapshots.read<Checkpoint>(head.ref) };
  },

  read<Checkpoint>(ref: SnapshotRecordRef): Promise<Checkpoint> {
    return readStreamRecord<Checkpoint>(ref.id);
  },

  async append<Checkpoint extends SnapshotWrite>(
    stream: SnapshotStreamRef,
    checkpoint: Checkpoint,
  ): Promise<SnapshotRecordRef> {
    const ref = recordRef(stream, checkpoint.writeId);
    if ((await streamTailIndex(ref.id)) !== -1) {
      const stored = await sessionSnapshots.read<Checkpoint>(ref);
      if (!(await equalSnapshot(stored, checkpoint))) {
        throw new Error(
          `Snapshot write identity "${checkpoint.writeId}" was reused with different state.`,
        );
      }
      return ref;
    }

    // Publish the address first: a crash can leave an unfinished record, but can
    // never make a retry publish an older completed checkpoint as the new head.
    const head = await readHead(stream);
    if (head === undefined) throw new Error("Session snapshot storage has not been initialized.");
    if (head.kind !== "record" || head.ref.id !== ref.id) {
      await appendStreamRecords<SnapshotEntry>(stream.id, [{ kind: "record", ref }]);
    }
    await appendStreamRecords(ref.id, [checkpoint], true);
    return ref;
  },

  close(ref: SnapshotStreamRef): Promise<void> {
    return appendStreamRecords(ref.id, [], true);
  },
};
