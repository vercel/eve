import { beforeEach, expect, it, vi } from "vitest";

import { createWorkflowToolInvocationReader } from "#execution/tools/workflow/invocation.js";

const mocks = vi.hoisted(() => ({
  executeWorkflowBody: vi.fn(),
  openWorkflowToolRunOwnerInbox: vi.fn(),
}));

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
  createWorkflowToolInvocationReader(input, new AbortController().signal);

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

  const reader = createWorkflowToolInvocationReader(input, new AbortController().signal);
  await expect(reader.iterator.next()).resolves.toEqual({ done: false, value: report });
  await expect(reader.iterator.next()).resolves.toEqual({
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
