import assert from "node:assert/strict";
import { test } from "node:test";

import { dependencySnapshotId } from "./dependency-snapshot.ts";

test("reuses a dependency sandbox's current snapshot", async () => {
  const snapshotId = await dependencySnapshotId({
    currentSnapshotId: "snapshot-current",
    snapshot: async () => {
      throw new Error("snapshot should not be called");
    },
  });

  assert.equal(snapshotId, "snapshot-current");
});

test("explicitly snapshots a dependency sandbox without a current snapshot", async () => {
  let expiration;
  const snapshotId = await dependencySnapshotId({
    currentSnapshotId: undefined,
    snapshot: async (options) => {
      expiration = options?.expiration;
      return { snapshotId: "snapshot-created" };
    },
  });

  assert.equal(snapshotId, "snapshot-created");
  assert.equal(expiration, 0);
});
