import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  buildSubagentRunInput: vi.fn(),
  cancelRun: vi.fn(),
  createSession: vi.fn(),
  createWorkflowRuntime: vi.fn(),
  getWorld: vi.fn(),
  logError: vi.fn(),
  waitForCommandHookOwner: vi.fn(),
}));

vi.mock("#execution/workflow-runtime.js", () => ({
  createWorkflowRuntime: mocks.createWorkflowRuntime,
  waitForCommandHookOwner: mocks.waitForCommandHookOwner,
}));
vi.mock("#internal/logging.js", () => ({
  createLogger: vi.fn(() => ({})),
  logError: mocks.logError,
}));
vi.mock("#internal/workflow/runtime.js", () => ({
  cancelRun: mocks.cancelRun,
  getWorld: mocks.getWorld,
}));
vi.mock("#subagents/tool.js", () => ({
  buildSubagentRunInput: mocks.buildSubagentRunInput,
}));

const { startLocalSubagent } = await import("#subagents/start-local.js");

type StartLocalSubagentInput = Parameters<typeof startLocalSubagent>[0];

const world = {};

function makeInput(): StartLocalSubagentInput {
  return {
    action: {
      callId: "call-1",
      description: "Delegate to research.",
      input: { message: "Research the request." },
      kind: "subagent-call",
      name: "research",
      nodeId: "subagents/research",
      subagentName: "research",
    },
    auth: null,
    batchEvent: { sequence: 0, turnId: "turn-0" },
    bundle: {
      compiledArtifactsSource: { kind: "bundled" },
      graph: {},
    } as StartLocalSubagentInput["bundle"],
    capabilities: undefined,
    channelMetadata: undefined,
    currentSession: {} as StartLocalSubagentInput["currentSession"],
    fanoutSize: 1,
    initiatorAuth: null,
    parentContinuationToken: undefined,
    parentTraceContext: undefined,
    sandboxSessionId: "sandbox-session",
    session: {} as StartLocalSubagentInput["session"],
    source: { description: "Research the request.", type: "local" },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.buildSubagentRunInput.mockReturnValue({
    childContinuationToken: "subagent:token",
    runInput: {},
  });
  mocks.cancelRun.mockResolvedValue(undefined);
  mocks.createSession.mockResolvedValue({ sessionId: "child-candidate" });
  mocks.createWorkflowRuntime.mockReturnValue({ createSession: mocks.createSession });
  mocks.getWorld.mockResolvedValue(world);
});

describe("startLocalSubagent", () => {
  it("uses the canonical hook owner after the child starts", async () => {
    mocks.waitForCommandHookOwner.mockResolvedValue({ runId: "child-owner" });

    await expect(startLocalSubagent(makeInput())).resolves.toMatchObject({
      address: {
        continuationToken: "subagent:token",
        kind: "agent/local",
        sessionId: "child-owner",
      },
      kind: "called",
    });
    expect(mocks.cancelRun).not.toHaveBeenCalled();
  });

  it("cancels the child candidate when its hook does not become ready", async () => {
    const failure = new Error("Hook not found");
    mocks.waitForCommandHookOwner.mockRejectedValue(failure);

    await expect(startLocalSubagent(makeInput())).resolves.toMatchObject({
      kind: "error",
      result: {
        output: { code: "SUBAGENT_START_FAILED", message: "Hook not found" },
      },
    });
    expect(mocks.cancelRun).toHaveBeenCalledWith(world, "child-candidate", {
      cancelReason: "Local subagent hook registration did not complete",
    });
  });

  it("preserves the startup error when child cancellation also fails", async () => {
    const startFailure = new Error("Hook not found");
    const cancellationFailure = new Error("Cancellation unavailable");
    mocks.waitForCommandHookOwner.mockRejectedValue(startFailure);
    mocks.cancelRun.mockRejectedValue(cancellationFailure);

    await expect(startLocalSubagent(makeInput())).resolves.toMatchObject({
      kind: "error",
      result: {
        output: { code: "SUBAGENT_START_FAILED", message: "Hook not found" },
      },
    });
    expect(mocks.logError).toHaveBeenCalledWith(
      expect.anything(),
      "failed to cancel local subagent after start failure",
      cancellationFailure,
      expect.objectContaining({ childSessionId: "child-candidate" }),
    );
  });

  it("does not cancel when child creation fails before returning a run id", async () => {
    mocks.createSession.mockRejectedValue(new Error("Start unavailable"));

    await expect(startLocalSubagent(makeInput())).resolves.toMatchObject({
      kind: "error",
      result: {
        output: { code: "SUBAGENT_START_FAILED", message: "Start unavailable" },
      },
    });
    expect(mocks.cancelRun).not.toHaveBeenCalled();
  });
});
