import { describe, expect, it } from "vitest";

import {
  workflowAskPayload,
  workflowToolRunFailureOutput,
  workflowToolRunOutcomeToToolResult,
} from "#execution/tools/workflow/owner-inbox.js";

const from = {
  callId: "call-1",
  input: { message: "Find it" },
  runId: "run-1",
  sequence: 0,
  stepIndex: 0,
  toolName: "research",
  turnId: "turn-1",
};

it("keeps the authored question heading in the relayed interaction", () => {
  const payload = workflowAskPayload({
    from,
    replyTo: "question-1",
    request: {
      kind: "ask",
      control: "run-control",
      request: {
        title: "Deployment review",
        prompt: "Which environment should Alice use?",
        options: [{ id: "staging", label: "Staging" }],
      },
    },
  });
  expect(payload.events).toMatchObject([
    {
      type: "interaction.opened",
      data: {
        interactionId: "question-1",
        request: {
          kind: "question",
          title: "Deployment review",
          prompt: "Which environment should Alice use?",
        },
      },
    },
  ]);
});

describe("workflow-tool task outcomes", () => {
  it("keeps a structured workflow failure as task failure data", () => {
    expect(
      workflowToolRunFailureOutput({
        from,
        result: {
          error: {
            code: "SUBAGENT_EXECUTION_FAILED",
            message: "child crashed",
          },
          status: "failed",
        },
      }),
    ).toEqual({
      code: "SUBAGENT_EXECUTION_FAILED",
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

it.each([undefined, "QUOTA"])("keeps the thrown workflow error name with code %s", (code) => {
  const error: Record<string, string> = { name: "QuotaError", message: "quota exceeded" };
  if (code !== undefined) error.code = code;
  const result = workflowToolRunOutcomeToToolResult({
    from,
    result: { status: "failed", error },
  });
  expect(result).toMatchObject({ errorName: "QuotaError", isError: true });
});
