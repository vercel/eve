import { afterEach, expect, it, vi } from "vitest";
import { workflowToolRunWorkflow } from "#execution/tools/workflow/workflow.js";

const mocks = vi.hoisted(() => ({
  control: vi.fn(),
  invocation: vi.fn(),
  deliver: vi.fn(),
  sleep: vi.fn(),
}));
vi.mock("#compiled/@workflow/core/index.js", () => ({ sleep: mocks.sleep }));
vi.mock("#execution/tools/workflow/run-control.js", () => ({
  openWorkflowToolRunControlInbox: mocks.control,
}));
vi.mock("#execution/tools/workflow/invocation.js", () => ({
  runWorkflowToolInvocation: mocks.invocation,
}));
vi.mock("#execution/tools/workflow/resume-hook-step.js", () => ({
  resumeHookStep: mocks.deliver,
}));
vi.mock("#execution/tools/workflow/body.js", () => ({
  createWorkflowBodyRef: () => from,
}));

vi.mock("#execution/tools/workflow/background-owner.js", () => ({
  runBackgroundWorkflowTool: vi.fn(),
}));

const from = {
  callId: "call",
  execution: "blocking" as const,
  input: {},
  runId: "run",
  sequence: 0,
  stepIndex: 0,
  toolName: "worker",
  turnId: "turn",
};
const input = {
  callId: "call",
  hookToken: "control",
  input: {},
  owner: { inbox: "owner" },
  session: {
    auth: { current: null, initiator: null },
    id: "session",
    turn: { id: "turn", sequence: 0 },
  },
  stepIndex: 0,
  toolName: "worker",
  workflowId: "workflow//worker",
};

afterEach(() => vi.resetAllMocks());

it("delivers a terminal invocation outcome to the turn owner", async () => {
  const controller = new AbortController();
  mocks.control.mockReturnValue({
    signal: controller.signal,
    cancelled: new Promise<never>(() => {}),
  });
  const message = {
    from,
    kind: "outcome" as const,
    result: { status: "completed" as const, output: "done" },
  };
  mocks.invocation.mockReturnValue(
    (async function* () {
      yield message;
    })(),
  );
  await workflowToolRunWorkflow(input);
  expect(mocks.deliver).toHaveBeenCalledExactlyOnceWith("owner", message, { ifPresent: false });
});
