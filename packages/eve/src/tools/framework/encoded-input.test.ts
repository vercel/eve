import { describe, expect, it } from "vitest";

import { ASK_QUESTION_INPUT_SCHEMA } from "#tools/framework/ask-question.js";
import { SUBAGENT_TOOL_INPUT_SCHEMA } from "#tools/framework/agent-contract.js";
import { TASK_CANCEL_INPUT_SCHEMA } from "#tools/framework/task-contract.js";

describe("framework tool schemas", () => {
  it("accepts JSON-encoded nested values from model tool calls", () => {
    expect(
      SUBAGENT_TOOL_INPUT_SCHEMA.safeParse({
        message: "Return a result.",
        outputSchema: JSON.stringify({ type: "object" }),
      }).success,
    ).toBe(true);

    expect(
      ASK_QUESTION_INPUT_SCHEMA.safeParse({
        options: JSON.stringify([{ id: "yes", label: "Yes" }]),
        prompt: "Continue?",
      }).success,
    ).toBe(true);

    expect(
      TASK_CANCEL_INPUT_SCHEMA.safeParse({ taskIds: JSON.stringify(["task-1"]) }).success,
    ).toBe(true);
  });

  it.each([
    ["malformed outputSchema JSON", { message: "Return a result.", outputSchema: "{" }],
    [
      "an outputSchema with the wrong decoded shape",
      { message: "Return a result.", outputSchema: JSON.stringify(["not", "an", "object"]) },
    ],
    ["malformed options JSON", { options: "[", prompt: "Continue?" }],
    [
      "options with the wrong decoded shape",
      { options: JSON.stringify({ id: "yes", label: "Yes" }), prompt: "Continue?" },
    ],
    ["malformed task ids JSON", { taskIds: "[" }],
    [
      "task ids with the wrong decoded shape",
      { taskIds: JSON.stringify({ taskId: "task-1" }) },
    ],
  ])("rejects %s", (_label, input) => {
    const schema =
      "outputSchema" in input
        ? SUBAGENT_TOOL_INPUT_SCHEMA
        : "options" in input
          ? ASK_QUESTION_INPUT_SCHEMA
          : TASK_CANCEL_INPUT_SCHEMA;

    expect(schema.safeParse(input).success).toBe(false);
  });
});
