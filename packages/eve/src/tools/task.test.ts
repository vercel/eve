import { describe, expect, it } from "vitest";

import { createTaskMessage } from "#tools/task.js";

describe("TaskExec descriptors", () => {
  it("builds non-empty parent messages", () => {
    expect(createTaskMessage("Review the export.")).toEqual({
      kind: "eve:task-message",
      message: "Review the export.",
    });
    expect(() => createTaskMessage("  ")).toThrow("Task messages must not be empty.");
  });
});
