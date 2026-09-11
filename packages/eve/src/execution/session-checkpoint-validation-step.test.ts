import { beforeEach, describe, expect, it, vi } from "vitest";

import type { SessionCheckpoint } from "#execution/session-handoff.js";
import { validateSessionCheckpointStep } from "#execution/session-checkpoint-validation-step.js";
import { BundleKey } from "#runtime/sessions/runtime-context-keys.js";

const deserializeContextMock = vi.fn();
const readDurableSessionMock = vi.fn();

vi.mock("#context/serialize.js", () => ({
  deserializeContext: (...args: unknown[]) => deserializeContextMock(...args),
}));
vi.mock("#execution/durable-session-store.js", () => ({
  readDurableSession: (...args: unknown[]) => readDurableSessionMock(...args),
}));

describe("validateSessionCheckpointStep", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("hydrates the target bundle and durable state for a complete hook set", async () => {
    const require = vi.fn();
    deserializeContextMock.mockResolvedValue({ require });
    readDurableSessionMock.mockResolvedValue({});
    const checkpoint = createCheckpoint();

    await validateSessionCheckpointStep({ checkpoint });

    expect(require).toHaveBeenCalledWith(BundleKey);
    expect(readDurableSessionMock).toHaveBeenCalledWith(checkpoint.sessionState);
  });

  it.each([
    ["an empty session-hook set", []],
    ["duplicate session hooks", ["stable", "channel:current", "channel:current"]],
    ["a missing current continuation", ["stable", "channel:old"]],
  ])("rejects %s before hydration", async (_label, session) => {
    const checkpoint = createCheckpoint({ session });

    await expect(validateSessionCheckpointStep({ checkpoint })).rejects.toThrow(
      /hook claim set|current continuation address/,
    );
    expect(deserializeContextMock).not.toHaveBeenCalled();
    expect(readDurableSessionMock).not.toHaveBeenCalled();
  });
});

function createCheckpoint(input: { readonly session?: readonly string[] } = {}): SessionCheckpoint {
  return {
    anchorToken: "session-1:anchor",
    hooks: {
      authorization: "session-1:auth",
      session: input.session ?? ["stable", "channel:old", "channel:current"],
    },
    mode: "conversation",
    ownership: {
      anchorRunId: "anchor-1",
      deploymentId: "deployment-a",
      ownerRunId: "owner-1",
      sessionId: "session-1",
    },
    serializedContext: {},
    sessionState: {
      continuationToken: "channel:current",
      emissionState: { sequence: 0, sessionStarted: true, stepIndex: 0, turnId: "turn_0" },
      hasProxyInputRequests: false,
      sessionId: "session-1",
      version: 1,
    },
  };
}
