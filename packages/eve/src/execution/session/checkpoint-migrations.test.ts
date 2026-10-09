import { describe, expect, it } from "vitest";

import { migrateSessionCheckpoint } from "#execution/session/checkpoint-migrations.js";
import { SESSION_CHECKPOINT_VERSION } from "#execution/session/handoff.js";

function checkpoint(version: number) {
  return {
    history: [],
    serializedContext: {},
    sessionState: { sessionId: "session-1", version: 2 },
    version,
  };
}

describe("migrateSessionCheckpoint", () => {
  it("accepts a current checkpoint unchanged", () => {
    expect(migrateSessionCheckpoint(checkpoint(SESSION_CHECKPOINT_VERSION))).toEqual({
      checkpoint: checkpoint(SESSION_CHECKPOINT_VERSION),
      childRunIdsToStop: [],
      kind: "current",
    });
  });

  it.each([8, 11, 13])("keeps a version %i session on the deployment that owns it", (version) => {
    expect(migrateSessionCheckpoint(checkpoint(version))).toEqual({
      detail: `checkpoint version ${version} predates v27 session events; the session continues on the deployment that owns it`,
      kind: "incompatible",
    });
  });

  it("refuses a checkpoint from a newer build", () => {
    expect(migrateSessionCheckpoint(checkpoint(SESSION_CHECKPOINT_VERSION + 1))).toMatchObject({
      kind: "incompatible",
    });
  });
});
