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
    const ctx = {} as ToolContext;
    const send = vi.fn();
    attachWorkflowToolRunContext(ctx, {
      agentContext: { capabilities: { requestInput: false } } as AgentSessionContext,
      asks: new WorkflowToolRunAsks("run"),
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

    await expect(ask(ctx, { prompt: "Which region?" })).resolves.toEqual({
      status: "unavailable",
    });
    expect(send).not.toHaveBeenCalled();
  });
});
