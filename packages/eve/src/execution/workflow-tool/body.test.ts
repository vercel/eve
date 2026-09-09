import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OwnerInbox } from "#execution/inbox/types.js";
import type { WorkflowBodyInput } from "#execution/workflow-tool/body.js";
const mocks = vi.hoisted(() => ({ execute: vi.fn(), send: vi.fn() }));
vi.mock("#compiled/@workflow/core/index.js", () => ({
  getWorkflowMetadata: () => ({ workflowRunId: "tool-run" }),
}));
vi.mock("#execution/workflow-registry.js", () => ({ readRegisteredWorkflow: () => mocks.execute }));
vi.mock("#execution/inbox/send.js", () => ({ sendInboxStep: mocks.send }));
import { executeWorkflowBody } from "#execution/workflow-tool/body.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}
async function flush() {
  for (let index = 0; index < 10; index++) await Promise.resolve();
}
const input: WorkflowBodyInput & { execution: "blocking" } = {
  execution: "blocking",
  callId: "call",
  input: {},
  owner: { token: "owner", ownerRunId: "turn" },
  session: {
    auth: { current: null, initiator: null },
    id: "session",
    turn: { id: "turn", sequence: 0 },
  },
  stepIndex: 0,
  toolName: "worker",
  workflowId: "worker",
};

describe("authored workflow generator cancellation", () => {
  beforeEach(() => vi.resetAllMocks());
  it("awaits the in-flight yield and generator cleanup before reporting cancellation", async () => {
    const signal = new AbortController();
    const step = deferred<string>();
    const cleanup = deferred<void>();
    const startedCleanup = vi.fn();
    mocks.execute.mockImplementation(async function* () {
      try {
        yield await step.promise;
      } finally {
        startedCleanup();
        await cleanup.promise;
      }
    });
    const ended = vi.fn();
    const result = executeWorkflowBody(input, signal.signal, {} as OwnerInbox).then((outcome) => {
      ended();
      return outcome;
    });
    signal.abort(new Error("cancelled"));
    await flush();
    expect(ended).not.toHaveBeenCalled();
    expect(startedCleanup).not.toHaveBeenCalled();
    step.resolve("completed pending step");
    await flush();
    expect(startedCleanup).toHaveBeenCalledOnce();
    expect(ended).not.toHaveBeenCalled();
    expect(mocks.send).not.toHaveBeenCalled();
    cleanup.resolve();
    await expect(result).resolves.toEqual({ status: "cancelled", reason: "cancelled" });
  });
});
