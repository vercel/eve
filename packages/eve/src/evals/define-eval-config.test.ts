import { describe, expect, it } from "vitest";

import { defineEvalConfig } from "#evals/define-eval-config.js";
import type { EveEvalConfigInput } from "#evals/types.js";

const TEST_MODEL = "openai/gpt-5.4-mini";

function defineInvalidConfig(input: Partial<EveEvalConfigInput> & Record<string, unknown>): void {
  defineEvalConfig(input as EveEvalConfigInput);
}

describe("defineEvalConfig", () => {
  it("returns a tagged config from valid input", () => {
    const config = defineEvalConfig({
      judge: { model: TEST_MODEL },
      maxConcurrency: 4,
      timeoutMs: 30000,
    });

    expect(config._tag).toBe("EveEvalConfig");
    expect(config.judge?.model).toBe(TEST_MODEL);
    expect(config.maxConcurrency).toBe(4);
    expect(config.timeoutMs).toBe(30000);
  });

  it("accepts an empty config (judge is optional)", () => {
    const config = defineEvalConfig({});
    expect(config._tag).toBe("EveEvalConfig");
    expect(config.judge).toBeUndefined();
  });

  it("requires a model when a judge is provided", () => {
    expect(() => defineInvalidConfig({ judge: {} as never })).toThrow("`judge` requires a `model`");
  });

  it("rejects a non-positive maxConcurrency", () => {
    expect(() => defineInvalidConfig({ maxConcurrency: 0 })).toThrow(
      "`maxConcurrency` must be a positive integer",
    );
    expect(() => defineInvalidConfig({ maxConcurrency: -1 })).toThrow(
      "`maxConcurrency` must be a positive integer",
    );
    expect(() => defineInvalidConfig({ maxConcurrency: 1.5 })).toThrow(
      "`maxConcurrency` must be a positive integer",
    );
  });

  it("rejects an invalid timeoutMs", () => {
    expect(() => defineInvalidConfig({ timeoutMs: -1 })).toThrow(
      "`timeoutMs` must be a non-negative finite number",
    );
  });

  it("rejects a non-array reporters", () => {
    expect(() => defineInvalidConfig({ reporters: {} as never })).toThrow(
      "`reporters` must be an array",
    );
  });
});
