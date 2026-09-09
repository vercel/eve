import type { SnapshotStreamRef } from "#execution/session/resources.js";
import { appendStreamRecords, readStreamRecord } from "#execution/session/stream-storage.js";

/** Only settled turn state lives here; intermediate state lives in Workflow step results. */
export const sessionSnapshots = {
  async initialize(ref: SnapshotStreamRef): Promise<void> {
    await appendStreamRecords(ref.id, [null]);
  },

  latest<Checkpoint>(ref: SnapshotStreamRef): Promise<Checkpoint | null> {
    return readStreamRecord<Checkpoint | null>(ref.id, -1);
  },

  append<Checkpoint>(ref: SnapshotStreamRef, checkpoint: Checkpoint): Promise<void> {
    return appendStreamRecords(ref.id, [checkpoint]);
  },

  close(ref: SnapshotStreamRef): Promise<void> {
    return appendStreamRecords(ref.id, [], true);
  },
};
