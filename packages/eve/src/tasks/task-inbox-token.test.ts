import { describe, expect, it } from "vitest";

import { readTaskIdFromInboxToken } from "#tasks/task-inbox-token.js";

describe("readTaskIdFromInboxToken", () => {
  const taskToken = `task:task_abc:${"a".repeat(32)}`;

  it("reads ordinary and workflow-relayed subagent task tokens", () => {
    expect(readTaskIdFromInboxToken(taskToken)).toBe("task_abc");
    expect(readTaskIdFromInboxToken(`${taskToken}:subagent:${"b".repeat(16)}`)).toBe("task_abc");
  });

  it("rejects unrelated suffixes", () => {
    expect(readTaskIdFromInboxToken(`${taskToken}:other:${"b".repeat(16)}`)).toBeUndefined();
  });
});
