import { describe, expect, it } from "vitest";

import { readTaskInputRequestId, readTaskUsage, sameTaskMetadata } from "#tasks/types.js";

describe("task kernel types", () => {
  it("compares only generic metadata identity", () => {
    expect(
      sameTaskMetadata({ kind: "tool", name: "export" }, { kind: "tool", name: "export" }),
    ).toBe(true);
    expect(
      sameTaskMetadata({ kind: "tool", name: "export" }, { kind: "tool", name: "import" }),
    ).toBe(false);
    expect(
      sameTaskMetadata(
        { agentId: "ag_1", kind: "subagent", mode: "remote", name: "research" },
        { agentId: "ag_2", kind: "subagent", mode: "remote", name: "research" },
      ),
    ).toBe(false);
  });

  it("reads opaque input request ids", () => {
    expect(readTaskInputRequestId({ prompt: "Continue?", requestId: "req-1" })).toBe("req-1");
    expect(readTaskInputRequestId({ prompt: "Continue?" })).toBeUndefined();
  });

  it("accepts complete non-negative usage and drops malformed usage", () => {
    const usage = {
      cacheReadTokens: 1,
      cacheWriteTokens: 2,
      costUsd: 0.25,
      inputTokens: 3,
      outputTokens: 4,
    };
    expect(readTaskUsage(usage)).toEqual(usage);
    expect(readTaskUsage({ ...usage, inputTokens: -1 })).toBeUndefined();
    expect(readTaskUsage({ inputTokens: 1 })).toBeUndefined();
  });
});
