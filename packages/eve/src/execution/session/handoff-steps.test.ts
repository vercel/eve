import { createTestSessionState } from "#internal/testing/session-state.js";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { SESSION_CHECKPOINT_VERSION, type SessionCheckpoint } from "#execution/session/handoff.js";
import { validateSessionCheckpointStep } from "#execution/session/handoff-steps.js";
import { BundleKey } from "#runtime/sessions/runtime-context-keys.js";

const deserializeContextMock = vi.fn();
const readDurableSessionMock = vi.fn();

vi.mock("#context/serialize.js", () => ({
  deserializeContext: (...args: unknown[]) => deserializeContextMock(...args),
}));
vi.mock("#execution/durable-session-store.js", async (importOriginal) => ({
  ...(await importOriginal()),
  readDurableSession: (...args: unknown[]) => readDurableSessionMock(...args),
}));

describe("validateSessionCheckpointStep", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("hydrates the target bundle and durable state for a complete hook set", async () => {
    const require = vi.fn();
    deserializeContextMock.mockResolvedValue({ require });
    readDurableSessionMock.mockReturnValue({});
    const checkpoint = createCheckpoint();

    await expect(validateSessionCheckpointStep({ checkpoint })).resolves.toEqual({ kind: "valid" });

    expect(require).toHaveBeenCalledWith(BundleKey);
    expect(readDurableSessionMock).toHaveBeenCalledWith(checkpoint.sessionState);
  });

  it("rejects a checkpoint that still holds input it hasn't run", async () => {
    deserializeContextMock.mockResolvedValue({ require: vi.fn() });
    readDurableSessionMock.mockReturnValue({
      state: {
        "eve.harness.turnState": {
          grants: [],
          queued: { message: "Alice asks for a summary." },
          suspended: [],
        },
      },
    });
    await expect(validateSessionCheckpointStep({ checkpoint: createCheckpoint() })).rejects.toThrow(
      "pending work",
    );
  });

  it.each([5, 6, 7, 8, 9, 10, 11, 13])(
    "reports checkpoint version %s as incompatible before reading nested state",
    async (version) => {
      const checkpoint = createCheckpoint();
      // Simulate an incompatible checkpoint received over the wire.
      Object.assign(checkpoint, { version });

      await expect(validateSessionCheckpointStep({ checkpoint })).resolves.toEqual({
        kind: "incompatible",
        reason: "checkpoint-version",
      });
      expect(deserializeContextMock).not.toHaveBeenCalled();
      expect(readDurableSessionMock).not.toHaveBeenCalled();
    },
  );

  it.each([undefined, -1, NaN, Infinity, "30000", true])(
    "rejects an invalid renewal duration (%s)",
    async (sessionTimeoutMs) => {
      const checkpoint = { ...createCheckpoint(), sessionTimeoutMs } as SessionCheckpoint;
      await expect(validateSessionCheckpointStep({ checkpoint })).rejects.toThrow(
        "invalid timeout duration",
      );
      expect(deserializeContextMock).not.toHaveBeenCalled();
    },
  );
});

function createCheckpoint(): SessionCheckpoint {
  return {
    version: SESSION_CHECKPOINT_VERSION,
    history: [],
    sessionTimeoutMs: false,
    serializedContext: {},
    sessionState: createTestSessionState({
      continuationToken: "channel:current",
      hasProxyInputRequests: false,
      sessionId: "session-1",
    }),
  };
}
