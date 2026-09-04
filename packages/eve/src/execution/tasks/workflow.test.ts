import { beforeEach, describe, expect, it, vi } from "vitest";
import { taskRunWorkflow } from "#execution/tasks/workflow.js";
import type { InboxEnvelope } from "#execution/inbox/types.js";
import type { TaskView } from "#tasks/types.js";

const mocks = vi.hoisted(() => ({
  claim: vi.fn(),
  observe: vi.fn(),
  next: vi.fn(),
  dispose: vi.fn(),
  publish: vi.fn(),
  append: vi.fn(),
  wakeAgent: vi.fn(),
  wake: vi.fn(),
  wakeUpdate: vi.fn(),
  wakeInput: vi.fn(),
  body: vi.fn(),
  watch: vi.fn(),
  deliver: vi.fn(),
}));
vi.mock("#execution/inbox/owner.js", () => ({
  createOwnerInbox: () => ({
    address: { token: "task-token", ownerRunId: "task-run" },
    claim: mocks.claim,
    next: mocks.next,
    dispose: mocks.dispose,
    observe: mocks.observe,
  }),
}));
vi.mock("#execution/inbox/admission.js", () => ({ watchAdmissionOwnerStep: mocks.watch }));
vi.mock("#execution/inbox/readiness.js", () => ({ publishOwnerStep: mocks.publish }));
vi.mock("#execution/tasks/steps.js", () => ({
  appendTaskViewStep: mocks.append,
  deliverTaskInputResponsesStep: mocks.deliver,
  wakeTaskAgentRequestParentStep: mocks.wakeAgent,
  wakeTaskAuthorizationParentStep: vi.fn(),
  wakeTaskParentStep: mocks.wake,
  wakeTaskUpdateParentStep: mocks.wakeUpdate,
  wakeWorkflowTaskInputRequestParentStep: mocks.wakeInput,
}));
vi.mock("#execution/workflow-tool/body.js", () => ({
  executeWorkflowBody: mocks.body,
  createWorkflowBodyRef: () => ({
    callId: "call",
    execution: "background",
    input: {},
    runId: "task-run",
    sequence: 0,
    stepIndex: 0,
    toolName: "worker",
    turnId: "turn",
  }),
}));
const initialView: TaskView = {
  metadata: { kind: "tool", name: "worker" },
  status: "working",
  taskId: "task",
};
const base = {
  admissionOwnerRunId: "turn-run",
  initialView,
  parentContinuationToken: "session-token",
  taskInboxToken: "task-token",
};
const workflow = {
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
};
const command = (kind: string, fields = {}): InboxEnvelope => ({
  eventId: kind,
  kind: "task.command",
  payload: { command: { ...fields, kind }, kind: "task-command" },
});
beforeEach(() => {
  vi.resetAllMocks();
  mocks.claim.mockResolvedValue({ kind: "owned" });
  mocks.observe.mockReturnValue(() => {});
  mocks.watch.mockImplementation(() => new Promise(() => {}));
  mocks.next.mockImplementation(() => new Promise(() => {}));
  mocks.body.mockResolvedValue({ status: "completed", output: "done" });
});

describe("task owner workflow", () => {
  it("publishes the winning address and terminates a duplicate start", async () => {
    mocks.claim.mockResolvedValue({ kind: "conflict", runId: "winner" });
    await taskRunWorkflow({ ...base, workflow });
    expect(mocks.publish).toHaveBeenCalledWith({ token: "task-token", ownerRunId: "winner" });
    expect(mocks.append).not.toHaveBeenCalled();
    expect(mocks.body).not.toHaveBeenCalled();
    expect(mocks.dispose).toHaveBeenCalledOnce();
  });

  it("terminates silently when closure precedes admission", async () => {
    mocks.watch.mockResolvedValue(undefined);
    mocks.next.mockResolvedValueOnce({
      eventId: "closed",
      kind: "admission.closed",
      payload: null,
    });
    await taskRunWorkflow({ ...base, workflow });
    expect(mocks.watch).toHaveBeenCalledExactlyOnceWith("turn-run", {
      token: "task-token",
      ownerRunId: "task-run",
    });
    expect(mocks.body).not.toHaveBeenCalled();
    expect(mocks.wake).not.toHaveBeenCalled();
    expect(mocks.append.mock.calls.at(-1)![0].view.status).toBe("cancelled");
    expect(mocks.dispose).toHaveBeenCalledOnce();
  });

  it("surfaces failed closure-marker delivery before admission", async () => {
    mocks.watch.mockRejectedValue(new Error("marker write failed"));
    await expect(taskRunWorkflow({ ...base, workflow })).rejects.toThrow("marker write failed");
    expect(mocks.body).not.toHaveBeenCalled();
    expect(mocks.dispose).toHaveBeenCalledOnce();
  });

  it("allows cancellation to finish before admission without waiting on the initiating turn", async () => {
    mocks.next.mockResolvedValueOnce(command("cancel"));
    await taskRunWorkflow({ ...base, workflow });
    expect(mocks.body).not.toHaveBeenCalled();
    expect(mocks.wake).not.toHaveBeenCalled();
    expect(mocks.append.mock.calls.at(-1)![0].view.status).toBe("cancelled");
    expect(mocks.dispose).toHaveBeenCalledOnce();
  });

  it("holds agent traffic until the creating session commits admission", async () => {
    const request = {
      from: {
        callId: "call",
        execution: "background",
        input: {},
        runId: "task-run",
        sequence: 0,
        stepIndex: 0,
        toolName: "worker",
        turnId: "turn",
      },
      replyTo: {
        kind: "inbox",
        address: { ownerRunId: "task-run", token: "task-token" },
        requestId: "invoke",
      },
      request: {
        kind: "agent-invoke",
        invocationId: "invoke",
        input: { target: "worker", message: "Do it" },
      },
    };
    mocks.next
      .mockResolvedValueOnce({ eventId: "invoke", kind: "tool.request", payload: request })
      .mockResolvedValueOnce(command("ready"))
      .mockResolvedValueOnce(command("complete", { data: "done" }));
    await taskRunWorkflow(base);
    expect(mocks.wakeAgent).toHaveBeenCalledWith({
      request,
      taskId: "task",
      token: "session-token",
    });
    expect(mocks.next.mock.invocationCallOrder[1]).toBeLessThan(
      mocks.wakeAgent.mock.invocationCallOrder[0]!,
    );
  });

  it("runs independently after admission when its initiating turn completes", async () => {
    const owner = Promise.withResolvers<void>();
    const started = Promise.withResolvers<void>();
    const finished = Promise.withResolvers<{ status: "completed"; output: string }>();
    mocks.watch.mockReturnValue(owner.promise);
    mocks.body.mockImplementation(() => {
      started.resolve();
      return finished.promise;
    });
    mocks.next.mockResolvedValueOnce(command("ready"));
    const run = taskRunWorkflow({ ...base, workflow });
    await started.promise;
    owner.resolve();
    await Promise.resolve();
    expect(mocks.body.mock.calls[0]![1].aborted).toBe(false);
    expect(mocks.dispose).not.toHaveBeenCalled();
    finished.resolve({ status: "completed", output: "done" });
    await run;
    expect(mocks.body).toHaveBeenCalledOnce();
    expect(mocks.body.mock.calls[0]![0].owner).toEqual({
      token: "task-token",
      ownerRunId: "task-run",
    });
    expect(mocks.append.mock.calls.at(-1)![0].view).toMatchObject({
      status: "completed",
      lastOutput: { data: "done" },
    });
    expect(mocks.wake).toHaveBeenCalledOnce();
  });

  it("never starts a body whose dispatch is rejected", async () => {
    mocks.next.mockResolvedValueOnce(command("reject-dispatch", { data: "failed" }));
    await taskRunWorkflow({ ...base, workflow });
    expect(mocks.body).not.toHaveBeenCalled();
    expect(mocks.wake).not.toHaveBeenCalled();
    expect(mocks.append.mock.calls.at(-1)![0].view.status).toBe("failed");
  });

  it("retains completion until parent admission arrives", async () => {
    mocks.next
      .mockResolvedValueOnce(command("complete", { data: "early" }))
      .mockResolvedValueOnce(command("ready"));
    await taskRunWorkflow(base);
    expect(mocks.wake).toHaveBeenCalledOnce();
    expect(mocks.wake.mock.calls[0]![0].view).toMatchObject({
      status: "completed",
      lastOutput: { data: "early" },
    });
  });
  it("retains overlapping questions from its one owner inbox", async () => {
    const ask = (requestId: string): InboxEnvelope => ({
      eventId: requestId,
      kind: "tool.request",
      payload: {
        from: {
          callId: "call",
          execution: "background",
          input: {},
          runId: "task-run",
          sequence: 0,
          stepIndex: 0,
          toolName: "worker",
          turnId: "turn",
        },
        replyTo: {
          kind: "inbox",
          address: { ownerRunId: "task-run", token: "task-token" },
          requestId,
        },
        request: { kind: "ask", request: { prompt: requestId } },
      },
    });
    mocks.next
      .mockResolvedValueOnce(command("ready"))
      .mockResolvedValueOnce(ask("one"))
      .mockResolvedValueOnce(ask("two"))
      .mockResolvedValueOnce(command("complete", { data: "done" }));
    await taskRunWorkflow(base);
    const waiting = mocks.append.mock.calls
      .map((call) => call[0].view)
      .filter((view) => view.status === "input_required");
    expect(
      waiting.at(-1).inputRequests.map((request: { requestId: string }) => request.requestId),
    ).toEqual(["one", "two"]);
    expect(mocks.wakeInput).toHaveBeenCalledTimes(2);
  });
  it("does not publish terminal cancellation or release ownership until its body quiesces", async () => {
    vi.useFakeTimers();
    try {
      let finish!: (outcome: { status: "completed"; output: string }) => void;
      mocks.body.mockReturnValue(
        new Promise((resolve) => {
          finish = resolve;
        }),
      );
      mocks.next.mockResolvedValueOnce(command("ready")).mockResolvedValueOnce(command("cancel"));
      const run = taskRunWorkflow({ ...base, workflow });
      await vi.advanceTimersByTimeAsync(60_000);
      expect(mocks.body.mock.calls[0]![1].aborted).toBe(true);
      expect(mocks.append.mock.calls.some((call) => call[0].view.status === "cancelled")).toBe(
        false,
      );
      expect(mocks.dispose).not.toHaveBeenCalled();
      finish({ status: "completed", output: "unwound" });
      await run;
      expect(mocks.append.mock.calls.at(-1)![0].view.status).toBe("cancelled");
      expect(mocks.dispose).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });
});
