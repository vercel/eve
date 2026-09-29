import { getEventListeners } from "node:events";
import { describe, expect, it, vi } from "vitest";

import {
  ask,
  attachWorkflowToolRunContext,
  WorkflowToolRunAsks,
} from "#execution/tools/workflow/ask.js";
import type { AgentSessionContext } from "#execution/agent-sessions/context.js";
import type { ToolContext } from "#tools/definition.js";

describe("ask", () => {
  it("resolves as unavailable without waiting when the session cannot request input", async () => {
    const { ctx, send } = runContext({ requestInput: false });

    await expect(ask(ctx, { prompt: "Which region?" })).resolves.toEqual({
      status: "unavailable",
    });
    expect(send).not.toHaveBeenCalled();
  });

  it("stops listening to its signals once answered, so a later abort withdraws nothing", async () => {
    const call = new AbortController();
    const caller = new AbortController();
    const { asks, ctx, send } = runContext({ abortSignal: call.signal, requestInput: true });

    const answer = ask(ctx, { prompt: "Which region?" }, { signal: caller.signal });
    asks.settle({
      kind: "answer",
      requestId: "run-ask-1",
      response: { status: "answered", text: "us-east-1" },
    });
    await expect(answer).resolves.toEqual({ status: "answered", text: "us-east-1" });

    expect(getEventListeners(call.signal, "abort")).toHaveLength(0);
    expect(getEventListeners(caller.signal, "abort")).toHaveLength(0);
    call.abort();
    caller.abort();
    await asks.flush();
    expect(send.mock.calls.map(([message]) => message.kind)).toEqual(["request"]);
  });
});

function runContext(input: { readonly abortSignal?: AbortSignal; readonly requestInput: boolean }) {
  const ctx = { abortSignal: input.abortSignal ?? new AbortController().signal } as ToolContext;
  const asks = new WorkflowToolRunAsks("run");
  const send = vi.fn(async (_message: { readonly kind: string }) => {});
  attachWorkflowToolRunContext(ctx, {
    agentContext: { capabilities: { requestInput: input.requestInput } } as AgentSessionContext,
    asks,
    auth: { current: null, initiator: null },
    control: "control",
    from: {
      callId: "call",
      input: {},
      runId: "run",
      sequence: 1,
      stepIndex: 0,
      toolName: "ask_question",
      turnId: "turn",
    },
    owner: { send, sent: 0 },
  });
  return { asks, ctx, send };
}
