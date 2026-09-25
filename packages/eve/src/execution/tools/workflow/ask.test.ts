import { describe, expect, it, vi } from "vitest";

import { createHook } from "#compiled/@workflow/core/index.js";
import { ask, attachWorkflowToolRunContext } from "#execution/tools/workflow/ask.js";
import type { ToolContext } from "#tools/definition.js";

vi.mock("#compiled/@workflow/core/index.js", () => ({ createHook: vi.fn() }));
vi.mock("#execution/tools/workflow/resume-hook-step.js", () => ({ resumeHookStep: vi.fn() }));

describe("ask", () => {
  it("resolves as unavailable without waiting when the session cannot request input", async () => {
    const ctx = {} as ToolContext;
    attachWorkflowToolRunContext(ctx, {
      canRequestInput: false,
      from: {
        callId: "call",
        generation: 1,
        input: {},
        runId: "run",
        sequence: 1,
        stepIndex: 0,
        taskId: "ask_question-abc234",
        toolName: "ask_question",
        turnId: "turn",
      },
      owner: { inbox: "inbox" },
    });

    await expect(ask(ctx, { prompt: "Which region?" })).resolves.toEqual({
      status: "unavailable",
    });
    expect(createHook).not.toHaveBeenCalled();
  });
});
