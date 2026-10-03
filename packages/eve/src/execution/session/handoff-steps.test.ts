import { createTestSessionState } from "#internal/testing/session-state.js";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { WorkflowRunNotFoundError } from "#compiled/@workflow/errors/index.js";
import { IncompatibleStateLayoutError } from "#context/serialize.js";
import { SESSION_CHECKPOINT_VERSION, type SessionCheckpoint } from "#execution/session/handoff.js";
import {
  stopUntrackedChildSessionsStep,
  validateSessionCheckpointStep,
} from "#execution/session/handoff-steps.js";
import { BundleKey } from "#runtime/sessions/runtime-context-keys.js";

const deserializeContextMock = vi.fn();
const readDurableSessionMock = vi.fn();
const cancelRunMock = vi.fn();

vi.mock("#context/serialize.js", async (importOriginal) => ({
  ...(await importOriginal()),
  deserializeContext: (...args: unknown[]) => deserializeContextMock(...args),
}));
vi.mock("#execution/durable-session-store.js", async (importOriginal) => ({
  ...(await importOriginal()),
  readDurableSession: (...args: unknown[]) => readDurableSessionMock(...args),
}));
vi.mock("#internal/workflow/runtime.js", async (importOriginal) => ({
  ...(await importOriginal()),
  cancelRun: (...args: unknown[]) => cancelRunMock(...args),
  getWorld: async () => ({}),
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

    await expect(validate(checkpoint)).resolves.toEqual({ kind: "valid" });

    expect(require).toHaveBeenCalledWith(BundleKey);
    expect(readDurableSessionMock).toHaveBeenCalledWith(checkpoint.sessionState);
  });

  it("rejects an incompatible workflow tool run with the current checkpoint version", async () => {
    deserializeContextMock.mockResolvedValue({ require: vi.fn() });
    readDurableSessionMock.mockReturnValue({
      state: {
        "eve.workflowTool": {
          version: 4,
          runs: [
            {
              callId: "call",
              toolName: "research",
              origin: { turnId: "turn", stepIndex: 0 },
              address: { runId: "run", hookToken: 42 },
            },
          ],
        },
      },
    });
    await expect(validate(createCheckpoint())).rejects.toThrow(
      "Corrupt workflow tool run registry",
    );
  });

  it("reports a checkpoint that could not be upgraded without reading it", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const detail = "checkpoint version 7 is outside the supported range";

    await expect(
      validateSessionCheckpointStep({
        migration: { kind: "incompatible", detail },
        sessionId: "session-1",
      }),
    ).resolves.toEqual({ kind: "incompatible", reason: "checkpoint-version" });
    expect(deserializeContextMock).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("cannot read the checkpoint"),
      expect.objectContaining({ detail, sessionId: "session-1" }),
    );
    warn.mockRestore();
  });

  it("answers rather than retries when saved state has no owner here", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    deserializeContextMock.mockRejectedValue(new IncompatibleStateLayoutError("acme-crm.requests"));

    await expect(validate(createCheckpoint())).resolves.toEqual({
      kind: "incompatible",
      reason: "checkpoint-version",
    });
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("cannot read the checkpoint"),
      expect.objectContaining({ detail: expect.stringContaining('"acme-crm.requests"') }),
    );
    warn.mockRestore();
  });

  it.each([undefined, -1, NaN, Infinity, "30000", true])(
    "rejects an invalid renewal duration (%s)",
    async (sessionTimeoutMs) => {
      const checkpoint = { ...createCheckpoint(), sessionTimeoutMs } as SessionCheckpoint;
      await expect(validate(checkpoint)).rejects.toThrow("invalid timeout duration");
      expect(deserializeContextMock).not.toHaveBeenCalled();
    },
  );
});

describe("stopUntrackedChildSessionsStep", () => {
  it("stops every child except the session itself and tolerates finished runs", async () => {
    cancelRunMock.mockReset();
    cancelRunMock.mockImplementation(async (_world: unknown, runId: string) => {
      if (runId === "child-gone") throw new WorkflowRunNotFoundError(runId);
    });

    await stopUntrackedChildSessionsStep({
      runIds: ["child-gone", "session-1", "child-parked"],
      sessionId: "session-1",
    });

    expect(cancelRunMock.mock.calls.map(([, runId]) => runId)).toEqual([
      "child-gone",
      "child-parked",
    ]);
  });
});

function validate(checkpoint: SessionCheckpoint) {
  return validateSessionCheckpointStep({
    migration: { kind: "current", checkpoint, childRunIdsToStop: [] },
    sessionId: "session-1",
  });
}

function createCheckpoint(): SessionCheckpoint {
  return {
    version: SESSION_CHECKPOINT_VERSION,
    history: [],
    sessionTimeoutMs: false,
    serializedContext: {},
    sessionState: createTestSessionState({
      continuationToken: "channel:current",
      emissionState: { sequence: 0, sessionStarted: true, stepIndex: 0, turnId: "turn_0" },
      sessionId: "session-1",
    }),
  };
}
