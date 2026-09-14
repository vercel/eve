import { describe, expect, it } from "vitest";

import { readTaskIdFromInboxToken } from "#tasks/task-inbox-token.js";

describe("readTaskIdFromInboxToken", () => {
  const taskToken = `task:task_abc:${"a".repeat(32)}`;

  it("reads an ordinary task token", () => {
    expect(readTaskIdFromInboxToken(taskToken)).toBe("task_abc");
  });

  it("rejects executor-specific suffixes", () => {
    expect(readTaskIdFromInboxToken(`${taskToken}:executor:${"b".repeat(16)}`)).toBeUndefined();
    expect(readTaskIdFromInboxToken(`${taskToken}:other:${"b".repeat(16)}`)).toBeUndefined();
  });
});
