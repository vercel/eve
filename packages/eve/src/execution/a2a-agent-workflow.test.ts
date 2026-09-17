import { beforeEach, describe, expect, it, vi } from "vitest";
import { a2aAgentWorkflow } from "#execution/a2a-agent-workflow.js";
import type { A2AWorkflowInput, A2ACommand } from "#runtime/a2a/types.js";

const mocks = vi.hoisted(() => ({
  operation: vi.fn(),
  result: vi.fn(),
  report: vi.fn(),
  hook: vi.fn(),
  sleep: vi.fn(),
}));
vi.mock("#compiled/@workflow/core/index.js", () => ({
  createHook: mocks.hook,
  getWorkflowMetadata: () => ({ workflowRunId: "bridge" }),
  sleep: mocks.sleep,
}));
vi.mock("#execution/a2a-agent-step.js", () => ({
  a2aOperationStep: mocks.operation,
  a2aResultStep: mocks.result,
}));
vi.mock("#execution/tools/workflow/resume-hook-step.js", () => ({ resumeHookStep: mocks.report }));
vi.mock("#execution/tools/workflow/step.js", () => ({
  readWorkflowAuthorizationCallback: (value: unknown) => value,
}));

function hook<T>(token: string) {
  const queue: T[] = [];
  let pending: ((result: IteratorResult<T>) => void) | undefined;
  return {
    token,
    dispose: vi.fn(),
    push(value: T) {
      if (pending) {
        const resolve = pending;
        pending = undefined;
        resolve({ done: false, value });
      } else queue.push(value);
    },
    [Symbol.asyncIterator]() {
      return {
        next: () =>
          new Promise<IteratorResult<T>>((resolve) => {
            if (queue.length) resolve({ done: false, value: queue.shift()! });
            else pending = resolve;
          }),
      };
    },
  };
}
const input: A2AWorkflowInput = {
  source: { kind: "development" },
  nodeId: "planner",
  name: "planner",
  callbackBaseUrl: "https://eve.example",
  invocation: {
    callId: "first",
    message: "Plan Alice's trip.",
    replyToken: "parent",
    session: {
      id: "parent",
      auth: { current: null, initiator: null },
      turn: { id: "turn", sequence: 1 },
    },
  },
};
function response(state: string) {
  return {
    authorized: [],
    kind: "result",
    output: {
      endpoint: { url: "https://peer.example/rpc", contract: "one" },
      response: {
        task: {
          id: "remote",
          contextId: "context",
          status: { state, message: { parts: [{ text: "Choose a city." }] } },
        },
      },
    },
  };
}
function sendCommand(message: string): A2ACommand {
  return {
    kind: "send",
    auth: null,
    invocation: { ...input.invocation, callId: "second", message },
  };
}
beforeEach(() => {
  vi.resetAllMocks();
  mocks.result.mockResolvedValue("Trip complete");
  mocks.sleep.mockImplementation(() => new Promise(() => {}));
});
describe("durable A2A adapter", () => {
  it("resumes input on the same remote task and retains context for later calls", async () => {
    const commands = hook<A2ACommand>("commands");
    mocks.hook.mockImplementation((options) => (options ? commands : hook("callback")));
    mocks.operation
      .mockResolvedValueOnce(response("TASK_STATE_INPUT_REQUIRED"))
      .mockResolvedValue(response("TASK_STATE_COMPLETED"));
    const run = a2aAgentWorkflow(input);
    await vi.waitFor(() => expect(mocks.report).toHaveBeenCalledOnce());
    expect(mocks.report.mock.calls[0]?.[1].results[0]).toMatchObject({
      output: { status: "input_required", message: "Choose a city." },
      outcome: { kind: "parked" },
    });
    commands.push(sendCommand("Paris"));
    await vi.waitFor(() => expect(mocks.report).toHaveBeenCalledTimes(2));
    expect(mocks.operation.mock.calls[1]?.[0].params.message).toMatchObject({
      taskId: "remote",
      contextId: "context",
      parts: [{ text: "Paris" }],
    });
    commands.push(sendCommand("Add a museum."));
    await vi.waitFor(() => expect(mocks.report).toHaveBeenCalledTimes(3));
    expect(mocks.operation.mock.calls[2]?.[0].params.message).not.toHaveProperty("taskId");
    expect(mocks.operation.mock.calls[2]?.[0].params.message.contextId).toBe("context");
    commands.push({ kind: "cancel" });
    await run;
    expect(commands.dispose).toHaveBeenCalledOnce();
  });
  it("surfaces remote authorization and polls the same task after resumption", async () => {
    const commands = hook<A2ACommand>("commands");
    mocks.hook.mockImplementation((options) => (options ? commands : hook("callback")));
    mocks.operation
      .mockResolvedValueOnce(response("TASK_STATE_AUTH_REQUIRED"))
      .mockResolvedValue(response("TASK_STATE_COMPLETED"));
    const run = a2aAgentWorkflow(input);
    await vi.waitFor(() => expect(mocks.report).toHaveBeenCalledOnce());
    expect(mocks.report.mock.calls[0]?.[1].results[0].output.status).toBe("authorization_required");
    commands.push(sendCommand("Alice has signed in."));
    await vi.waitFor(() => expect(mocks.report).toHaveBeenCalledTimes(2));
    expect(mocks.operation.mock.calls[1]?.[0]).toMatchObject({
      method: "GetTask",
      params: { id: "remote" },
    });
    commands.push({ kind: "cancel" });
    await run;
  });
  it("resumes shared authorization and reports its completion before the task result", async () => {
    const commands = hook<A2ACommand>("commands");
    const callbacks = hook("callback");
    mocks.hook.mockImplementation((options) => (options ? commands : callbacks));
    mocks.operation
      .mockResolvedValueOnce({
        kind: "authorization-required",
        signal: {
          challenges: [
            {
              attemptId: "attempt",
              name: "planner",
              challenge: { url: "https://login.example" },
              hookUrl: "https://eve.example/callback",
            },
          ],
        },
      })
      .mockResolvedValue(response("TASK_STATE_COMPLETED"));
    const run = a2aAgentWorkflow(input);
    await vi.waitFor(() => expect(mocks.report).toHaveBeenCalledOnce());
    expect(mocks.report.mock.calls[0]?.[1]).toMatchObject({
      kind: "subagent-authorization-event",
      event: { type: "authorization.required" },
    });
    callbacks.push({ type: "authorized" });
    await vi.waitFor(() => expect(mocks.report).toHaveBeenCalledTimes(3));
    expect(mocks.operation.mock.calls[1]?.[1].authorizationResults).toHaveLength(1);
    expect(mocks.report.mock.calls[1]?.[1]).toMatchObject({
      event: { type: "authorization.completed" },
    });
    commands.push({ kind: "cancel" });
    await run;
  });

  it("cancels a working remote task without waiting for an OAuth callback", async () => {
    const commands = hook<A2ACommand>("commands");
    const callback = hook("callback");
    mocks.hook.mockImplementation((options) => (options ? commands : callback));
    mocks.sleep.mockResolvedValue(undefined);
    mocks.operation.mockResolvedValueOnce(response("TASK_STATE_WORKING")).mockResolvedValue({
      kind: "authorization-required",
      signal: {
        challenges: [
          {
            attemptId: "attempt",
            name: "planner",
            challenge: { url: "https://login.example" },
            hookUrl: "https://eve.example/callback",
          },
        ],
      },
    });
    const run = a2aAgentWorkflow(input);
    await vi.waitFor(() => expect(mocks.report).toHaveBeenCalledOnce());
    commands.push({ kind: "cancel" });
    await run;
    expect(mocks.operation.mock.calls.at(-1)?.[0]).toMatchObject({
      method: "CancelTask",
      params: { id: "remote" },
    });
    expect(mocks.report).toHaveBeenCalledOnce();
    expect(commands.dispose).toHaveBeenCalledOnce();
  });
  it("does not retry an ambiguously failed send", async () => {
    const commands = hook<A2ACommand>("commands");
    mocks.hook.mockImplementation((options) => (options ? commands : hook("callback")));
    mocks.operation.mockRejectedValue(new Error("network disconnected"));
    await a2aAgentWorkflow(input);
    expect(mocks.operation).toHaveBeenCalledOnce();
    expect(mocks.report.mock.calls[0]?.[1].results[0]).toMatchObject({
      isError: true,
      outcome: { kind: "terminal" },
    });
  });
});
