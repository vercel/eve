import { describe, expect, it } from "vitest";

import { BASH_INPUT_SCHEMA } from "./bash.js";

describe("BASH_INPUT_SCHEMA", () => {
  it("accepts an optional positive timeout in seconds", () => {
    expect(BASH_INPUT_SCHEMA.safeParse({ command: "pnpm test", timeout: 30 }).success).toBe(true);
    expect(BASH_INPUT_SCHEMA.safeParse({ command: "pnpm test" }).success).toBe(true);
  });

  it("rejects non-positive timeouts", () => {
    expect(BASH_INPUT_SCHEMA.safeParse({ command: "pnpm test", timeout: 0 }).success).toBe(false);
    expect(BASH_INPUT_SCHEMA.safeParse({ command: "pnpm test", timeout: -1 }).success).toBe(false);
  });
});
