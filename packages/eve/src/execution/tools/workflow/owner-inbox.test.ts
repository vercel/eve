import { describe, expect, it } from "vitest";

import {
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
