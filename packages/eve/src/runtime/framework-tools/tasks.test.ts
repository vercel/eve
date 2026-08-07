import { describe, expect, it } from "vitest";

import { TASK_SEND_INPUT_SCHEMA } from "#runtime/framework-tools/tasks.js";

describe("task_send input", () => {
  it("accepts only terminal-task message follow-ups", () => {
    expect(
      TASK_SEND_INPUT_SCHEMA.safeParse({ message: "continue", taskId: "task_1" }).success,
    ).toBe(true);
    expect(
      TASK_SEND_INPUT_SCHEMA.safeParse({
        inputResponses: [{ optionId: "approve", requestId: "request_1" }],
        taskId: "task_1",
      }).success,
    ).toBe(false);
  });
});
