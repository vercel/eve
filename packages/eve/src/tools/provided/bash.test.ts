import { describe, expect, it } from "vitest";

import { z } from "#compiled/zod/index.js";

import { BASH_INPUT_SCHEMA, BASH_OUTPUT_SCHEMA } from "./bash.js";

describe("bash schemas", () => {
  it("emits a provider-compatible object schema", () => {
    const schema = z.toJSONSchema(BASH_INPUT_SCHEMA, { io: "input" });
    expect(schema).toMatchObject({
      required: ["action", "command", "processId", "yieldTimeMs"],
      type: "object",
    });
    expect(schema).not.toHaveProperty("anyOf");
  });

  it("accepts an optional nonnegative foreground yield time in milliseconds", () => {
    expect(BASH_INPUT_SCHEMA.safeParse({ command: "pnpm test", yieldTimeMs: 0 }).success).toBe(
      true,
    );
    expect(BASH_INPUT_SCHEMA.safeParse({ command: "pnpm test" }).success).toBe(true);
    expect(
      BASH_INPUT_SCHEMA.safeParse({ command: "pnpm test", yieldTimeMs: 10 * 60_000 }).success,
    ).toBe(true);
    expect(BASH_INPUT_SCHEMA.safeParse({ command: "pnpm test", yieldTimeMs: -1 }).success).toBe(
      false,
    );
  });

  it("accepts process follow-up operations through the same interface", () => {
    expect(BASH_INPUT_SCHEMA.safeParse({ action: "poll", processId: "process-123" }).success).toBe(
      true,
    );
    expect(
      BASH_INPUT_SCHEMA.safeParse({ action: "wait", processId: "process-123", yieldTimeMs: 30_000 })
        .success,
    ).toBe(true);
    expect(BASH_INPUT_SCHEMA.safeParse({ action: "kill", processId: "process-123" }).success).toBe(
      true,
    );
    expect(BASH_INPUT_SCHEMA.safeParse({ action: "poll" }).success).toBe(false);
    expect(BASH_INPUT_SCHEMA.safeParse({ command: "pwd", action: "poll" }).success).toBe(false);
    expect(
      BASH_INPUT_SCHEMA.safeParse({
        action: "run",
        command: "pwd",
        processId: "",
        yieldTimeMs: null,
      }).success,
    ).toBe(true);
  });

  it("distinguishes completed commands from running process receipts", () => {
    expect(
      BASH_OUTPUT_SCHEMA.safeParse({
        exitCode: 0,
        status: "completed",
        stderr: "",
        stdout: "done",
        truncated: false,
        wallTimeSeconds: 1.5,
      }).success,
    ).toBe(true);
    expect(
      BASH_OUTPUT_SCHEMA.safeParse({
        processId: "process-123",
        status: "running",
        stderr: "",
        stdout: "partial",
        truncated: false,
        wallTimeSeconds: 300,
      }).success,
    ).toBe(true);
    expect(
      BASH_OUTPUT_SCHEMA.safeParse({
        exitCode: 0,
        status: "completed",
        stderr: "",
        stdout: "done",
        truncated: false,
      }).success,
    ).toBe(false);
  });
});
