import { describe, expect, it } from "vitest";

import { migrateSessionCheckpoint } from "#execution/session/checkpoint-migrations.js";
import { SESSION_CHECKPOINT_VERSION } from "#execution/session/handoff.js";

function checkpoint(version: number) {
  return {
    admittedDeliveryKeys: [],
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
      kind: "current",
    });
  });

  it.each([8, 11, 13, 14, 15, 16, 17])(
    "keeps a version %i session on the deployment that owns it",
    (version) => {
      expect(migrateSessionCheckpoint(checkpoint(version))).toEqual({
        detail: `checkpoint version ${version} predates v27 session events; the session continues on the deployment that owns it`,
        kind: "incompatible",
      });
    },
  );

  it.each([
    undefined,
    ["alice", 1],
    [""],
    ["x".repeat(257)],
    Array.from({ length: 1025 }, (_, index) => `delivery-${index}`),
  ])(
    "refuses a current checkpoint with an invalid delivery-key window (%#)",
    (admittedDeliveryKeys) => {
      expect(
        migrateSessionCheckpoint({
          ...checkpoint(SESSION_CHECKPOINT_VERSION),
          admittedDeliveryKeys,
        }),
      ).toMatchObject({ kind: "incompatible" });
    },
  );

  it("refuses a checkpoint from a newer build", () => {
    expect(migrateSessionCheckpoint(checkpoint(SESSION_CHECKPOINT_VERSION + 1))).toMatchObject({
      kind: "incompatible",
    });
  });
});
