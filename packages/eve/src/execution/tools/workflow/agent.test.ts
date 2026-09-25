import { beforeEach, describe, expect, it, vi } from "vitest";

import type { RuntimeActionResultHookPayload } from "#channel/types.js";
import { ask, attachWorkflowToolRunContext } from "#execution/tools/workflow/ask.js";
import type { WorkflowToolRunRef } from "#execution/tools/workflow/messages.js";
import { agent, validateAgentInput } from "#execution/tools/workflow/agent.js";
import type { JsonValue } from "#shared/json.js";
import type { ToolContext } from "#tools/definition.js";

const mocks = vi.hoisted(() => ({
  createHook: vi.fn(),
  disposeHook: vi.fn(),
  resumeHook: vi.fn(),
}));

vi.mock("#compiled/@workflow/core/index.js", async (importOriginal) => ({
  ...(await importOriginal()),
  createHook: mocks.createHook,
}));
vi.mock("#execution/hook-ownership.js", () => ({
  disposeHook: mocks.disposeHook,
}));
vi.mock("#execution/tools/workflow/resume-hook-step.js", () => ({
  resumeHookStep: (...args: unknown[]) => mocks.resumeHook(...args),
}));
beforeEach(() => vi.resetAllMocks());

describe("workflow helper context errors", () => {
  it.each([
    ["ordinary tool", { callId: "call-1", session: {} }],
    ["channel handler", { from() {}, to() {}, waitUntil() {} }],
    ["schedule handler", { to() {}, waitUntil() {}, appAuth: {} }],
    ["missing context", undefined],
    ["null context", null],
  ])("rejects %s before creating hooks or dispatching work", async (_name, context) => {
    const ctx = context as ToolContext;
    await expect(agent(ctx, "reviewer", { message: "Review" })).rejects.toThrow(
      "ctx.agent() requires a defineWorkflowTool() executor context.",
    );
    expect(() => ask(ctx, { prompt: "Continue?" })).toThrow(
      "ctx.ask() requires a defineWorkflowTool() executor context.",
    );
    expect(mocks.createHook).not.toHaveBeenCalled();
    expect(mocks.resumeHook).not.toHaveBeenCalled();
  });
});

describe("agent invocation input", () => {
  it("requires a non-empty positional agent name", () => {
    expect(() => validateAgentInput({ message: "Review", target: "" })).toThrow(
      "agent() requires a non-empty agent name as its first argument.",
    );
  });

  it.each([null, [], "object"])("rejects a non-object output schema (%j)", (outputSchema) => {
    expect(() =>
      validateAgentInput({
        message: "Review",
        outputSchema: outputSchema as never,
        target: "reviewer",
      }),
    ).toThrow("agent() `outputSchema` must be a JSON Schema object.");
  });
});

const from: WorkflowToolRunRef = {
  callId: "call-1",
  generation: 1,
  input: { message: "Find it" },
  runId: "run-1",
  sequence: 0,
  stepIndex: 0,
  taskId: "research-abc234",
  toolName: "research",
  turnId: "turn-1",
};

function createWorkflowContext(signal?: AbortSignal): ToolContext {
  const ctx = { abortSignal: signal, callId: "call-1" } as ToolContext;
  attachWorkflowToolRunContext(ctx, { from, owner: { inbox: "owner-inbox" } });
  return ctx;
}

function replyHook(token: string, replies: RuntimeActionResultHookPayload[]) {
  return {
    [Symbol.asyncIterator]: () => ({
      next: async () =>
        replies.length > 0
          ? { done: false as const, value: replies.shift()! }
          : { done: true as const, value: undefined },
    }),
    token,
  };
}

function childResult(callId: string, output: JsonValue) {
  return {
    callId,
    kind: "subagent-result" as const,
    origin: "child" as const,
    outcome: {
      kind: "parked" as const,
      result: { kind: "succeeded" as const, output },
      usageDelta: { cacheReadTokens: 0, cacheWriteTokens: 0, inputTokens: 0, outputTokens: 0 },
    },
    output,
    subagentName: "research",
  };
}

describe("workflow agent invocation routing", () => {
  it("stops waiting when the workflow body is cancelled", async () => {
    const controller = new AbortController();
    mocks.createHook.mockReturnValue({
      [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => {}) }),
      token: "agent-reply",
    });

    const result = agent(createWorkflowContext(controller.signal), "research", {
      message: "Find it",
    });
    await vi.waitFor(() => expect(mocks.resumeHook).toHaveBeenCalledOnce());
    controller.abort(new Error("run cancelled"));

    await expect(result).rejects.toThrow("run cancelled");
    expect(mocks.disposeHook).toHaveBeenCalledOnce();
  });

  it("sends only the invocation to the owner and returns the settled result", async () => {
    const output = { findings: ["available"] };
    mocks.createHook.mockReturnValue(
      replyHook("agent-reply", [
        { kind: "runtime-action-result", results: [childResult("call-1:agent-reply", output)] },
      ]),
    );
    const outputSchema = {
      properties: { findings: { items: { type: "string" }, type: "array" } },
      required: ["findings"],
      type: "object",
    };

    await expect(
      agent(createWorkflowContext(), "research", { message: "Find it", outputSchema }),
    ).resolves.toEqual(output);

    expect(mocks.resumeHook).toHaveBeenCalledExactlyOnceWith("owner-inbox", {
      from,
      kind: "request",
      replyTo: "agent-reply",
      request: {
        input: { message: "Find it", outputSchema, target: "research" },
        invocationId: "call-1:agent-reply",
        kind: "agent-invoke",
      },
    });
    expect(mocks.disposeHook).toHaveBeenCalledOnce();
  });

  it("ignores results for other invocations", async () => {
    mocks.createHook.mockReturnValue(
      replyHook("agent-reply", [
        { kind: "runtime-action-result", results: [childResult("call-1:other", "stale")] },
        { kind: "runtime-action-result", results: [childResult("call-1:agent-reply", "done")] },
      ]),
    );

    await expect(agent(createWorkflowContext(), "research", { message: "Find it" })).resolves.toBe(
      "done",
    );
  });

  it("derives unique invocation ids for repeated parallel calls", async () => {
    for (const token of ["reply-1", "reply-2"]) {
      mocks.createHook.mockReturnValueOnce(
        replyHook(token, [
          { kind: "runtime-action-result", results: [childResult(`call-1:${token}`, token)] },
        ]),
      );
    }
    const ctx = createWorkflowContext();

    await expect(
      Promise.all([
        agent(ctx, "research", { message: "First" }),
        agent(ctx, "research", { message: "Second" }),
      ]),
    ).resolves.toEqual(["reply-1", "reply-2"]);

    expect(mocks.resumeHook.mock.calls.map(([, message]) => message.request.invocationId)).toEqual([
      "call-1:reply-1",
      "call-1:reply-2",
    ]);
  });

  it("rejects with the output of a failed invocation", async () => {
    const failure = {
      callId: "call-1:agent-reply",
      isError: true as const,
      kind: "subagent-result" as const,
      origin: "dispatch" as const,
      output: {
        code: "START_FAILED",
        message: "The remote agent could not be started.",
      },
      subagentName: "research",
    };
    mocks.createHook.mockReturnValue(
      replyHook("agent-reply", [{ kind: "runtime-action-result", results: [failure] }]),
    );

    await expect(
      agent(createWorkflowContext(), "research", { message: "Find it" }),
    ).rejects.toEqual(failure.output);
    expect(mocks.resumeHook).toHaveBeenCalledOnce();
  });

  it("fails when the reply hook closes without a result", async () => {
    mocks.createHook.mockReturnValue(replyHook("agent-reply", []));

    await expect(
      agent(createWorkflowContext(), "research", { message: "Find it" }),
    ).rejects.toThrow('Agent "research" closed without a result.');
  });
});
