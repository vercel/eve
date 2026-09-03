import { describe, expect, it } from "vitest";

import { createTaskMessage, createTaskSetState } from "#tools/task.js";

describe("TaskExec descriptors", () => {
  it("builds serializable task state", () => {
    expect(createTaskSetState({ progress: 0.5 })).toEqual({
      kind: "eve:task-set-state",
      state: { progress: 0.5 },
    });
  });

  it("builds non-empty parent messages", () => {
    expect(createTaskMessage("Review the export.")).toEqual({
      kind: "eve:task-message",
      message: "Review the export.",
    });
    expect(() => createTaskMessage("  ")).toThrow("Task messages must not be empty.");
  });
});
