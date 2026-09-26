import { beforeEach, expect, it, vi } from "vitest";

import type {
  WorkflowToolRunControlMessage,
  WorkflowToolRunMessage,
} from "#execution/tools/workflow/messages.js";
import { workflowToolRunWorkflow } from "#execution/tools/workflow/workflow.js";

const mocks = vi.hoisted(() => ({
  sleep: vi.fn(),
  control: vi.fn(),
  deliver: vi.fn(),
  executeWorkflowBody: vi.fn(),
  openWorkflowToolRunOwnerInbox: vi.fn(),
}));

vi.mock("#compiled/@workflow/core/index.js", () => ({ sleep: mocks.sleep }));

vi.mock("#execution/tools/workflow/workflow-owner-blocking.js", () => ({
  createBlockingWorkflow: mocks.control,
}));
vi.mock("#execution/tools/workflow/resume-hook-step.js", () => ({ resumeHookStep: mocks.deliver }));

vi.mock("#execution/tools/workflow/body.js", () => ({
  createWorkflowBodyRef: (input: {
    callId: string;
    input: object;
    session: { turn: { id: string; sequence: number } };
    stepIndex: number;
    toolName: string;
  }) => ({
    callId: input.callId,
    input: input.input,
    runId: "run-1",
    sequence: input.session.turn.sequence,
    stepIndex: input.stepIndex,
    toolName: input.toolName,
    turnId: input.session.turn.id,
  }),
  executeWorkflowBody: mocks.executeWorkflowBody,
}));
vi.mock("#execution/tools/workflow/owner.js", () => ({
  openWorkflowToolRunOwnerInbox: mocks.openWorkflowToolRunOwnerInbox,
}));

import { createChannelReader } from "#execution/tools/workflow/owner-channels.js";

const input = {
  hookToken: "control",
  owner: { inbox: "parent" },
  callId: "call-1",
  input: {},
  session: {
    auth: { current: null, initiator: null },
    id: "session-1",
    turn: { id: "turn-1", sequence: 0 },
  },
  stepIndex: 0,
  toolName: "worker",
  workflowId: "workflow//eve//worker",
};

beforeEach(() => {
  vi.resetAllMocks();
  setControl(new AbortController());
  mocks.executeWorkflowBody.mockResolvedValue({
    outcome: { output: "done", status: "completed" },
    messageCount: 1,
  });
});

it("emits every persisted report before the terminal outcome", async () => {
  const report = {
    from: {
      callId: "call-1",
      input: {},
      runId: "run-1",
      sequence: 0,
      stepIndex: 0,
      toolName: "worker",
      turnId: "turn-1",
    },
    kind: "report" as const,
    update: "halfway",
  };
  mocks.openWorkflowToolRunOwnerInbox.mockReturnValue({
    owner: { inbox: "invocation-owner" },
    reader: createChannelReader(
      "workflow",
      (async function* () {
        // The body settles before the persisted report reaches its owner.
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
        yield report;
      })(),
    ),
  });

  await workflowToolRunWorkflow(input);
  expect(mocks.deliver).toHaveBeenNthCalledWith(1, "parent", report, { ifPresent: false });
  expect(mocks.deliver).toHaveBeenNthCalledWith(
    2,
    "parent",
    {
      from: expect.objectContaining({ callId: "call-1" }),
      kind: "outcome",
      result: { output: "done", status: "completed" },
    },
    { ifPresent: false },
  );
  expect(mocks.executeWorkflowBody).toHaveBeenCalledWith(
    expect.objectContaining({ owner: { inbox: "invocation-owner" } }),
    expect.any(AbortSignal),
  );
});

it.each(["completed", "failed", "cancelled", "throw", "blocked"] as const)(
  "keeps cancellation final when cleanup is %s",
  async (status) => {
    const controller = new AbortController();
    const release = Promise.withResolvers<void>();
    const started = Promise.withResolvers<void>();
    mocks.sleep.mockImplementation(async () => {
      if (status === "blocked") return;
      await new Promise<void>(() => {});
    });
    mocks.openWorkflowToolRunOwnerInbox.mockReturnValue({
      owner: { inbox: "owner" },
      reader: createChannelReader("workflow", {
        [Symbol.asyncIterator]: () => ({
          next: () => new Promise<IteratorResult<never>>(() => {}),
        }),
      }),
    });
    mocks.executeWorkflowBody.mockImplementation(async () => {
      started.resolve();
      await release.promise;
      if (status === "throw") throw new Error("cleanup failed");
      return {
        messageCount: 0,
        outcome:
          status === "failed"
            ? { status, error: "failed" }
            : status === "cancelled"
              ? { status, reason: "body cancelled" }
              : { status: "completed", output: "late success" },
      };
    });
    setControl(controller);
    const completion = workflowToolRunWorkflow(input);
    await started.promise;
    controller.abort(new Error("stop"));
    if (status !== "blocked") release.resolve();
    await completion;
    expect(mocks.deliver).toHaveBeenCalledExactlyOnceWith(
      "parent",
      expect.objectContaining({
        kind: "outcome",
        result: { status: "cancelled", reason: "stop" },
      }),
      { ifPresent: true },
    );
  },
);

it("preserves the pending inbox read across cancellation and drains the report before settling", async () => {
  const controller = new AbortController();
  const pending = Promise.withResolvers<IteratorResult<WorkflowToolRunMessage>>();
  const next = vi.fn(() => pending.promise);
  const report: WorkflowToolRunMessage = {
    from: {
      callId: input.callId,
      input: input.input,
      runId: "run-1",
      sequence: 0,
      stepIndex: 0,
      toolName: input.toolName,
      turnId: "turn-1",
    },
    kind: "report",
    update: "cleanup progress",
  };
  mocks.sleep.mockReturnValue(new Promise<void>(() => {}));
  mocks.openWorkflowToolRunOwnerInbox.mockReturnValue({
    owner: { inbox: "owner" },
    reader: createChannelReader("workflow", { [Symbol.asyncIterator]: () => ({ next }) }),
  });
  setControl(controller);
  const completion = workflowToolRunWorkflow(input);
  await vi.waitFor(() => expect(next).toHaveBeenCalledOnce());
  controller.abort(new Error("stop"));
  await vi.waitFor(() => expect(mocks.sleep).toHaveBeenCalledOnce());
  pending.resolve({ done: false, value: report });
  await completion;
  expect(mocks.deliver).toHaveBeenNthCalledWith(1, "parent", report, { ifPresent: false });
  expect(next).toHaveBeenCalledOnce();
  expect(mocks.deliver).toHaveBeenNthCalledWith(
    2,
    "parent",
    expect.objectContaining({
      kind: "outcome",
      result: { status: "cancelled", reason: "stop" },
    }),
    { ifPresent: true },
  );
});

function setControl(controller: AbortController) {
  const { signal } = controller;
  mocks.control.mockReturnValue({
    signal,
    commands: createChannelReader(
      "control",
      (async function* () {
        if (!signal.aborted)
          await new Promise<void>((resolve) =>
            signal.addEventListener("abort", () => resolve(), { once: true }),
          );
        yield { kind: "cancel", reason: "stop" };
        await new Promise<void>(() => {});
      })(),
    ),
    handleCommand: vi.fn(),
    handleMessage: (message: WorkflowToolRunMessage) =>
      mocks.deliver("parent", message, {
        ifPresent: message.kind === "outcome" && message.result.status === "cancelled",
      }),
  });
}

it("applies cancellation buffered during the last report delivery before publishing completion", async () => {
  const controller = new AbortController();
  const cancel = Promise.withResolvers<void>();
  const commands = createChannelReader(
    "control",
    (async function* (): AsyncGenerator<WorkflowToolRunControlMessage> {
      await cancel.promise;
      yield { kind: "cancel", reason: "stop" };
      await new Promise<void>(() => {});
    })(),
  );
  const report: WorkflowToolRunMessage = {
    from: {
      callId: input.callId,
      input: {},
      runId: "run-1",
      sequence: 0,
      stepIndex: 0,
      toolName: input.toolName,
      turnId: "turn-1",
    },
    kind: "report",
    update: "finished",
  };
  const deliver = vi.fn(async (message: WorkflowToolRunMessage) => {
    if (message.kind === "report") {
      cancel.resolve();
      await vi.waitFor(() => expect(commands.landed).toHaveLength(1));
    }
  });
  mocks.control.mockReturnValue({
    commands,
    signal: controller.signal,
    handleMessage: deliver,
    handleCommand: () => controller.abort(new Error("stop")),
  });
  mocks.sleep.mockReturnValue(new Promise<void>(() => {}));
  mocks.openWorkflowToolRunOwnerInbox.mockReturnValue({
    owner: { inbox: "owner" },
    reader: createChannelReader(
      "workflow",
      (async function* () {
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
        yield report;
        await new Promise<void>(() => {});
      })(),
    ),
  });
  await workflowToolRunWorkflow(input);
  expect(deliver).toHaveBeenNthCalledWith(1, report);
  expect(deliver).toHaveBeenNthCalledWith(
    2,
    expect.objectContaining({
      kind: "outcome",
      result: { status: "cancelled", reason: "stop" },
    }),
  );
  expect(deliver).toHaveBeenCalledTimes(2);
});

it("keeps waiting for the body after the control hook closes", async () => {
  mocks.control.mockReturnValue({
    signal: new AbortController().signal,
    commands: createChannelReader("control", (async function* () {})()),
    handleCommand: vi.fn(),
    handleMessage: mocks.deliver,
  });
  mocks.executeWorkflowBody.mockResolvedValue({
    messageCount: 0,
    outcome: { status: "completed", output: "done" },
  });
  mocks.openWorkflowToolRunOwnerInbox.mockReturnValue({
    owner: { inbox: "owner" },
    reader: createChannelReader("workflow", {
      [Symbol.asyncIterator]: () => ({
        next: () => new Promise<IteratorResult<WorkflowToolRunMessage>>(() => {}),
      }),
    }),
  });
  await workflowToolRunWorkflow(input);
  expect(mocks.deliver).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({
      kind: "outcome",
      result: { status: "completed", output: "done" },
    }),
  );
});

it("propagates terminal delivery failure instead of replacing the invocation outcome", async () => {
  mocks.executeWorkflowBody.mockResolvedValue({
    messageCount: 0,
    outcome: { status: "completed", output: "done" },
  });
  mocks.openWorkflowToolRunOwnerInbox.mockReturnValue({
    owner: { inbox: "owner" },
    reader: createChannelReader("workflow", {
      [Symbol.asyncIterator]: () => ({
        next: () => new Promise<IteratorResult<WorkflowToolRunMessage>>(() => {}),
      }),
    }),
  });
  mocks.deliver.mockRejectedValue(new Error("delivery failed"));
  await expect(workflowToolRunWorkflow(input)).rejects.toThrow("delivery failed");
  expect(mocks.deliver).toHaveBeenCalledOnce();
});
