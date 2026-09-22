import { createTestSessionState } from "#internal/testing/session-state.js";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { SessionCheckpoint } from "#execution/session/handoff.js";
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

    await validateSessionCheckpointStep({ checkpoint });

    expect(require).toHaveBeenCalledWith(BundleKey);
    expect(readDurableSessionMock).toHaveBeenCalledWith(checkpoint.sessionState);
  });

  it("rejects an incompatible settled task with the current checkpoint version", async () => {
    deserializeContextMock.mockResolvedValue({ require: vi.fn() });
    readDurableSessionMock.mockReturnValue({
      state: {
        "eve.workflowTool": {
          version: 3,
          runs: [
            {
              callId: "task",
              toolName: "research",
              lifetime: "session" as const,
              origin: { turnId: "turn", stepIndex: 0 },
              address: { runId: "run", hookToken: 42 },
              task: {
                taskId: "task",
                metadata: { kind: "tool", name: "research" },
                outcome: {
                  status: "cancelled",
                },
                dispatchContext: { auth: { current: null, initiator: null } },
              },
            },
          ],
        },
      },
    });
    await expect(validateSessionCheckpointStep({ checkpoint: createCheckpoint() })).rejects.toThrow(
      "Corrupt workflow tool run registry",
    );
  });

  it.each([undefined, null, [123], [""]])(
    "rejects invalid cancellation state %j",
    async (cancelledTaskIds) => {
      const checkpoint = createCheckpoint();
      Object.assign(checkpoint, { cancelledTaskIds });
      await expect(validateSessionCheckpointStep({ checkpoint })).rejects.toThrow(
        "invalid task cancellation state",
      );
    },
  );

  it.each([4, 5, 6, 7, 9])(
    "rejects checkpoint version %s before reading nested state",
    async (version) => {
      const checkpoint = createCheckpoint();
      // Simulate an incompatible checkpoint received over the wire.
      Object.assign(checkpoint, { version });

      await expect(validateSessionCheckpointStep({ checkpoint })).rejects.toThrow(
        `Unsupported session checkpoint version ${version}`,
      );
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
    version: 8,
    cancelledTaskIds: [],
    sessionTimeoutMs: false,
    mode: "conversation",
    serializedContext: {},
    sessionState: createTestSessionState({
      continuationToken: "channel:current",
      emissionState: { sequence: 0, sessionStarted: true, stepIndex: 0, turnId: "turn_0" },
      hasProxyInputRequests: false,
      sessionId: "session-1",
      version: 1,
    }),
  };
}
