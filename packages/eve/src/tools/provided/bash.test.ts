import { describe, expect, it } from "vitest";

import { BASH_INPUT_SCHEMA, BASH_OUTPUT_SCHEMA } from "./bash.js";

describe("bash schemas", () => {
  it("accepts an optional nonnegative foreground yield duration", () => {
    expect(BASH_INPUT_SCHEMA.safeParse({ command: "pnpm test", yieldAfter: 0 }).success).toBe(true);
    expect(BASH_INPUT_SCHEMA.safeParse({ command: "pnpm test" }).success).toBe(true);
    expect(BASH_INPUT_SCHEMA.safeParse({ command: "pnpm test", yieldAfter: -1 }).success).toBe(
      false,
    );
  });

  it("accepts process follow-up operations through the same interface", () => {
    expect(BASH_INPUT_SCHEMA.safeParse({ action: "poll", processId: "process-123" }).success).toBe(
      true,
    );
    expect(
      BASH_INPUT_SCHEMA.safeParse({ action: "wait", processId: "process-123", yieldAfter: 30 })
        .success,
    ).toBe(true);
    expect(BASH_INPUT_SCHEMA.safeParse({ action: "kill", processId: "process-123" }).success).toBe(
      true,
    );
  });

  it("distinguishes completed commands from running process receipts", () => {
    expect(
      BASH_OUTPUT_SCHEMA.safeParse({
        exitCode: 0,
        status: "completed",
        stderr: "",
        stdout: "done",
        truncated: false,
      }).success,
    ).toBe(true);
    expect(
      BASH_OUTPUT_SCHEMA.safeParse({
        processId: "process-123",
        status: "running",
        stderr: "",
        stdout: "partial",
        truncated: false,
      }).success,
    ).toBe(true);
  });
});
