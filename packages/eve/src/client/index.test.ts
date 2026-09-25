import { describe, expectTypeOf, it } from "vitest";

import type { TaskCancelOutput, TaskReceipt, TaskWaitOutput } from "#client/index.js";

describe("eve/client task tool outputs", () => {
  it("types the structured results clients read from task tool calls", () => {
    expectTypeOf<TaskReceipt>().toEqualTypeOf<{
      readonly status: "working";
      readonly taskId: string;
    }>();
    expectTypeOf<TaskCancelOutput["status"]>().toEqualTypeOf<"cancelled" | "already_finished">();
    expectTypeOf<TaskWaitOutput["status"]>().toEqualTypeOf<
      "settled" | "timed_out" | "interrupted" | "idle"
    >();
    expectTypeOf<
      Extract<TaskWaitOutput, { status: "settled" }>["outcome"]["status"]
    >().toEqualTypeOf<"completed" | "failed" | "cancelled">();
  });
});
