import { describe, expect, it } from "vitest";

import { createSubagentRelayFailure } from "#execution/tool-run/workflow.js";
import type { ToolRunWorkflowInput } from "#execution/tool-run/types.js";
import { SubagentRelayError } from "#execution/tools/subagent/workflow.js";

describe("subagent tool run failures", () => {
  it("maps a relay exception to the pending subagent call identity", () => {
    const input = {
      callId: "call-1",
      subagent: { replyToken: "child-hook", subagentName: "research" },
    } as ToolRunWorkflowInput;

    expect(
      createSubagentRelayFailure(
        input,
        new SubagentRelayError(new Error("child hook failed"), true),
      ),
    ).toEqual({
      callId: "call-1",
      isError: true,
      kind: "subagent-result",
      origin: "child",
      outcome: {
        kind: "terminal",
        result: {
          error: { code: "SUBAGENT_EXECUTION_FAILED", message: "child hook failed" },
          kind: "failed",
        },
        usageDelta: {
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          inputTokens: 0,
          outputTokens: 0,
        },
      },
      output: { code: "SUBAGENT_EXECUTION_FAILED", message: "child hook failed" },
      subagentName: "research",
    });
  });

  it("keeps dispatch provenance when the relay never adopted a child", () => {
    const input = {
      callId: "call-1",
      subagent: { replyToken: "child-hook", subagentName: "research" },
    } as ToolRunWorkflowInput;

    expect(
      createSubagentRelayFailure(
        input,
        new SubagentRelayError(new Error("child hook unavailable"), false),
      ),
    ).toEqual({
      callId: "call-1",
      isError: true,
      kind: "subagent-result",
      origin: "dispatch",
      output: { code: "SUBAGENT_EXECUTION_FAILED", message: "child hook unavailable" },
      subagentName: "research",
    });
  });
});
