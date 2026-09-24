import { describe, expect, it } from "vitest";

import type { RuntimeSubagentChildResult } from "#shared/action-types.js";
import { failEmptyResult, toTaskOutcome } from "#tasks/outcome.js";

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
          'Agent "researcher" finished without a reply. If you still need its answer, give it more work with its agentId.',
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
