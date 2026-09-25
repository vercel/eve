import { describe, expect, it } from "vitest";

import type { RuntimeSubagentChildResult } from "#shared/action-types.js";
import { createTaskRecord } from "#internal/testing/task-records.js";
import { failEmptyResult, toTaskOutcome, toToolResult } from "#tasks/outcome.js";

const USAGE = { cacheReadTokens: 0, cacheWriteTokens: 0, inputTokens: 3, outputTokens: 0 };

function answer(output: RuntimeSubagentChildResult["output"]): RuntimeSubagentChildResult {
  return {
    callId: "call-1",
    kind: "subagent-result",
    origin: "child",
    outcome: { kind: "parked", result: { kind: "succeeded", output }, usageDelta: USAGE },
    output,
    subagentName: "researcher",
  };
}

describe("failEmptyResult", () => {
  it.each([[""], ["  \n"]])("fails an answer with no text (%j) as EMPTY_RESULT", (output) => {
    const failed = failEmptyResult(answer(output));

    expect(toTaskOutcome(failed)).toEqual({
      error: {
        code: "EMPTY_RESULT",
        message:
          'Agent "researcher" finished without a reply. If you still need its answer, call its tool again with its taskId.',
      },
      status: "failed",
    });
    expect(failed).toMatchObject({ isError: true, outcome: { kind: "parked", usageDelta: USAGE } });
  });

  it("keeps an answer with text and a structured result, which an output schema asks for", () => {
    expect(failEmptyResult(answer("Found it."))).toEqual(answer("Found it."));
    expect(failEmptyResult(answer({}))).toEqual(answer({}));
  });
});

describe("toToolResult", () => {
  it("gives a cancelled agent call an error result without a code, like a cancelled workflow tool", () => {
    const cancelled: RuntimeSubagentChildResult = {
      ...answer("The agent invocation was cancelled."),
      isError: true,
      outcome: { kind: "parked", result: { kind: "cancelled" }, usageDelta: USAGE },
    };

    expect(toTaskOutcome(cancelled)).toEqual({ status: "cancelled" });
    expect(toToolResult(createTaskRecord(), cancelled, { status: "cancelled" })).toEqual({
      callId: "call-1",
      isError: true,
      kind: "tool-result",
      output: "The agent invocation was cancelled.",
      toolName: "research",
    });
  });
});
