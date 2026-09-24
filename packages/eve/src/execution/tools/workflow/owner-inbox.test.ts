import { describe, expect, it } from "vitest";

import {
  workflowAskInputEvent,
  workflowToolRunFailureOutput,
} from "#execution/tools/workflow/owner-inbox.js";

const from = {
  callId: "call-1",
  input: { message: "Find it" },
  runId: "run-1",
  sequence: 0,
  stepIndex: 0,
  taskId: "research-abc234",
  toolName: "research",
  turnId: "turn-1",
};

describe("workflow-tool task input", () => {
  it("rejects an ask without a prompt", () => {
    expect(() =>
      workflowAskInputEvent({
        from,
        replyTo: "answer-hook",
        request: { kind: "ask", request: { prompt: "" } },
      }),
    ).toThrow("A workflow tool run request needs a non-empty `prompt`.");
  });
});

describe("workflow-tool task outcomes", () => {
  it("keeps a structured workflow failure as task failure data", () => {
    expect(
      workflowToolRunFailureOutput({
        from,
        result: {
          error: {
            code: "EXECUTION_FAILED",
            message: "child crashed",
          },
          status: "failed",
        },
      }),
    ).toEqual({
      code: "EXECUTION_FAILED",
      message: "child crashed",
    });
  });

  it("keeps ordinary workflow-tool task failures as message strings", () => {
    expect(
      workflowToolRunFailureOutput({
        from,
        result: {
          error: {
            message: "export failed",
          },
          status: "failed",
        },
      }),
    ).toEqual("export failed");
  });
});
