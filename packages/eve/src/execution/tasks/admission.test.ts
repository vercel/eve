import { beforeEach, describe, expect, it, vi } from "vitest";
import { WorkflowRunFailedError } from "#compiled/@workflow/errors/index.js";
import type { InboxEnvelope } from "#execution/inbox/types.js";
import { taskRunWorkflow } from "#execution/tasks/workflow.js";

const mocks = vi.hoisted(() => ({
  createHook: vi.fn(),
  getRun: vi.fn(),
  resumeHook: vi.fn(),
  append: vi.fn(),
  body: vi.fn(),
  wake: vi.fn(),
}));
vi.mock("#compiled/@workflow/core/index.js", () => ({
  createHook: mocks.createHook,
  getWorkflowMetadata: () => ({ workflowRunId: "task-run" }),
}));
vi.mock("#internal/workflow/runtime.js", () => ({
  getRun: mocks.getRun,
  resumeHook: mocks.resumeHook,
}));
vi.mock("#execution/inbox/readiness.js", () => ({ publishOwnerStep: vi.fn() }));
vi.mock("#execution/tasks/steps.js", () => ({
  appendTaskViewStep: mocks.append,
  deliverTaskInputResponsesStep: vi.fn(),
  wakeTaskAgentRequestParentStep: vi.fn(),
  wakeTaskAuthorizationParentStep: vi.fn(),
  wakeTaskParentStep: mocks.wake,
  wakeTaskUpdateParentStep: vi.fn(),
  wakeWorkflowTaskInputRequestParentStep: vi.fn(),
}));
vi.mock("#execution/workflow-tool/body.js", () => ({
  executeWorkflowBody: mocks.body,
  createWorkflowBodyRef: () => ({ runId: "task-run", callId: "call", execution: "background" }),
}));

const input = {
  admissionOwnerRunId: "turn-run",
  initialView: {
    metadata: { kind: "tool" as const, name: "worker" },
    status: "working" as const,
    taskId: "task",
  },
  parentContinuationToken: "session-token",
  taskInboxToken: "task-token",
  workflow: {
    callId: "call",
    input: {},
    session: {
      auth: { current: null, initiator: null },
      id: "session",
      turn: { id: "turn", sequence: 0 },
    },
    stepIndex: 0,
    toolName: "worker",
    workflowId: "workflow",
  },
};
const ready: InboxEnvelope = {
  eventId: "ready",
  kind: "task.command",
  payload: { kind: "task-command", command: { kind: "ready" } },
};

function bufferedHook(envelopes: InboxEnvelope[]) {
  const queue = [...envelopes];
  let waiting: ((result: IteratorResult<InboxEnvelope>) => void) | undefined;
  const dispose = vi.fn(() => waiting?.({ done: true, value: undefined }));
  const hook = {
    token: "task-token",
    getConflict: async () => null,
    dispose,
    [Symbol.asyncIterator]: () => ({
      async next(): Promise<IteratorResult<InboxEnvelope>> {
        const value = queue.shift();
        if (value !== undefined) return { done: false, value };
        return new Promise((resolve) => {
          waiting = resolve;
        });
      },
    }),
  };
  mocks.createHook.mockReturnValue(hook);
  const enqueue = (envelope: InboxEnvelope): void => {
    if (waiting === undefined) queue.push(envelope);
    else {
      const resolve = waiting;
      waiting = undefined;
      resolve({ done: false, value: envelope });
    }
  };
  mocks.resumeHook.mockImplementation(async (_token, envelope) => {
    enqueue(envelope);
    return { runId: "task-run" };
  });
  return { dispose, enqueue };
}

function earlyUpdates(): InboxEnvelope[] {
  return Array.from({ length: 50 }, (_, index) => ({
    eventId: `update-${index}`,
    kind: "task.command",
    payload: {
      kind: "task-update",
      callId: "call",
      updateEpoch: "executor",
      updateIndex: index,
      message: `Progress ${index}`,
    },
  }));
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.body.mockResolvedValue({ status: "completed", output: "done" });
});

describe("task admission through the real inbox reader", () => {
  it.each(["owner read", "marker delivery"])(
    "fails and disposes when the admission %s fails instead of waiting forever",
    async (operation) => {
      const hook = bufferedHook([]);
      const error = new Error("Storage is unavailable.");
      mocks.getRun.mockImplementation(() => ({
        returnValue: operation === "owner read" ? Promise.reject(error) : Promise.resolve(),
      }));
      if (operation === "marker delivery") mocks.resumeHook.mockRejectedValue(error);
      await expect(taskRunWorkflow(input)).rejects.toBe(error);
      expect(mocks.body).not.toHaveBeenCalled();
      expect(hook.dispose).toHaveBeenCalledOnce();
    },
  );

  it.each(["completed", "failed"])(
    "honors committed readiness behind early traffic when the initiating turn has %s",
    async (outcome) => {
      const hook = bufferedHook([...earlyUpdates(), ready]);
      mocks.getRun.mockImplementation(() => ({
        returnValue:
          outcome === "completed"
            ? Promise.resolve(undefined)
            : Promise.reject(
                new WorkflowRunFailedError("turn-run", new Error("Failed after admission.")),
              ),
      }));
      await taskRunWorkflow(input);
      expect(mocks.body).toHaveBeenCalledOnce();
      expect(mocks.append.mock.calls.at(-1)![0].view.status).toBe("completed");
      expect(mocks.wake).toHaveBeenCalledOnce();
      expect(hook.dispose).toHaveBeenCalledOnce();
    },
  );

  it("cancels when admission closes before readiness, even with earlier traffic buffered", async () => {
    const hook = bufferedHook(earlyUpdates());
    mocks.resumeHook.mockImplementation(async (_token, envelope) => {
      hook.enqueue(envelope);
      hook.enqueue(ready);
      return { runId: "task-run" };
    });
    mocks.getRun.mockReturnValue({ returnValue: Promise.resolve(undefined) });
    await taskRunWorkflow(input);
    expect(mocks.body).not.toHaveBeenCalled();
    expect(mocks.append.mock.calls.at(-1)![0].view.status).toBe("cancelled");
    expect(mocks.wake).not.toHaveBeenCalled();
    expect(hook.dispose).toHaveBeenCalledOnce();
  });
});
