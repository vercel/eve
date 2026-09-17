import { beforeEach, expect, it, vi } from "vitest";

import type { WorkflowToolRunMessage } from "#execution/tools/workflow/messages.js";
import { runWorkflowToolInvocation } from "#execution/tools/workflow/invocation.js";

const mocks = vi.hoisted(() => ({
  sleep: vi.fn(),
  executeWorkflowBody: vi.fn(),
  openWorkflowToolRunOwnerInbox: vi.fn(),
}));

vi.mock("#compiled/@workflow/core/index.js", () => ({ sleep: mocks.sleep }));

vi.mock("#execution/tools/workflow/body.js", () => ({
  createWorkflowBodyRef: (input: {
    callId: string;
    execution: "background" | "blocking";
    input: object;
    session: { turn: { id: string; sequence: number } };
    stepIndex: number;
    toolName: string;
  }) => ({
    callId: input.callId,
    execution: input.execution,
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
  callId: "call-1",
  execution: "background" as const,
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
  mocks.executeWorkflowBody.mockResolvedValue({
    outcome: { output: "done", status: "completed" },
    reportCount: 1,
  });
});

it("does not start the body until the invocation owner reads", async () => {
  runWorkflowToolInvocation(input, new AbortController().signal);

  expect(mocks.executeWorkflowBody).not.toHaveBeenCalled();
});

it("emits every persisted report before the terminal outcome", async () => {
  const report = {
    from: {
      callId: "call-1",
      execution: "background" as const,
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

  const reader = runWorkflowToolInvocation(input, new AbortController().signal);
  await expect(reader.next()).resolves.toEqual({ done: false, value: report });
  await expect(reader.next()).resolves.toEqual({
    done: false,
    value: {
      from: expect.objectContaining({ callId: "call-1", execution: "background" }),
      kind: "outcome",
      result: { output: "done", status: "completed" },
    },
  });
  expect(mocks.executeWorkflowBody).toHaveBeenCalledWith(
    expect.objectContaining({ owner: { inbox: "invocation-owner" } }),
    expect.any(AbortSignal),
  );
});

for (const execution of ["blocking", "background"] as const) {
  it.each(["completed", "failed", "cancelled", "throw", "blocked"] as const)(
    `${execution} keeps cancellation final when cleanup is %s`,
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
          reportCount: 0,
          outcome:
            status === "failed"
              ? { status, error: "failed" }
              : status === "cancelled"
                ? { status, reason: "body cancelled" }
                : { status: "completed", output: "late success" },
        };
      });
      const reader = runWorkflowToolInvocation({ ...input, execution }, controller.signal);
      const next = reader.next();
      await started.promise;
      controller.abort(new Error("stop"));
      if (status !== "blocked") release.resolve();
      await expect(next).resolves.toMatchObject({
        done: false,
        value: {
          kind: "outcome",
          result: { status: "cancelled", reason: "stop" },
        },
      });
      await expect(reader.next()).resolves.toMatchObject({ done: true });
    },
  );
}

it("does not start a body cancelled before its first read", async () => {
  const controller = new AbortController();
  controller.abort(new Error("never admitted"));
  const reader = runWorkflowToolInvocation(input, controller.signal);
  await expect(reader.next()).resolves.toMatchObject({
    value: { result: { status: "cancelled" } },
  });
  expect(mocks.executeWorkflowBody).not.toHaveBeenCalled();
  expect(mocks.openWorkflowToolRunOwnerInbox).not.toHaveBeenCalled();
  expect(mocks.sleep).not.toHaveBeenCalled();
});

it("preserves the pending inbox read across cancellation and drains the report before settling", async () => {
  const controller = new AbortController();
  const pending = Promise.withResolvers<IteratorResult<WorkflowToolRunMessage>>();
  const next = vi.fn(() => pending.promise);
  const report: WorkflowToolRunMessage = {
    from: {
      callId: input.callId,
      execution: input.execution,
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
  const invocation = runWorkflowToolInvocation(input, controller.signal);
  const first = invocation.next();
  await vi.waitFor(() => expect(next).toHaveBeenCalledOnce());
  controller.abort(new Error("stop"));
  await vi.waitFor(() => expect(mocks.sleep).toHaveBeenCalledOnce());
  pending.resolve({ done: false, value: report });
  await expect(first).resolves.toEqual({ done: false, value: report });
  expect(next).toHaveBeenCalledOnce();
  await expect(invocation.next()).resolves.toMatchObject({
    value: { kind: "outcome", result: { status: "cancelled", reason: "stop" } },
  });
  await expect(invocation.next()).resolves.toMatchObject({ done: true });
});
