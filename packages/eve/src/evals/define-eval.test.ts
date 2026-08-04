import { describe, expect, it } from "vitest";

import { defineEval } from "#evals/define-eval.js";
import type { EveEvalInput, EveEvalInputFields } from "#evals/types.js";

const TEST_MODEL = "openai/gpt-5.4-mini";

function defineInvalidEval(input: Partial<EveEvalInputFields> & Record<string, unknown>): void {
  defineEval(input as EveEvalInput);
}

describe("defineEval", () => {
  it("returns a tagged eval from a valid `test` function", () => {
    const evaluation = defineEval({
      async test(t) {
        await t.send("hello");
      },
    });

    expect(evaluation._tag).toBe("EveEval");
    expect(typeof evaluation.test).toBe("function");
  });

  it("accepts an optional judge override", () => {
    const evaluation = defineEval({
      judge: { model: TEST_MODEL },
      async test(t) {
        await t.send("hello");
      },
    });

    expect(evaluation.judge?.model).toBe(TEST_MODEL);
  });

  it("rejects authored `id` because eval identity is path-derived", () => {
    expect(() =>
      defineInvalidEval({
        id: "test-eval",
        async test() {},
      } as Partial<EveEvalInput> & { id: string }),
    ).toThrow("must not specify `id`");
  });

  it("rejects authored `name` because eval identity is path-derived", () => {
    expect(() =>
      defineInvalidEval({
        name: "Test Eval",
        async test() {},
      } as Partial<EveEvalInput> & { name: string }),
    ).toThrow("must not specify `name`");
  });

  it("throws when no `test` function is provided", () => {
    expect(() => defineInvalidEval({})).toThrow("requires a `test(t)` function");
  });

  it.each([
    ["input", "smoke ping"],
    ["run", async () => undefined],
    ["checks", []],
    ["scores", []],
    ["expected", "world"],
    ["thresholds", {}],
    ["parseOutput", () => undefined],
    ["model", TEST_MODEL],
    ["modelOptions", {}],
    ["cases", [{ input: "hi" }]],
  ])("rejects the removed `%s` key with a migration hint", (key, value) => {
    expect(() =>
      defineInvalidEval({
        async test() {},
        [key]: value,
      }),
    ).toThrow(`\`${key}\` is no longer supported`);
  });

  it("throws when timeoutMs is invalid", () => {
    expect(() =>
      defineEval({
        async test() {},
        timeoutMs: -100,
      }),
    ).toThrow("non-negative finite number");
  });

  it("throws on the removed `requires` key", () => {
    expect(() =>
      defineInvalidEval({
        async test() {},
        requires: ["mockModels"],
      }),
    ).toThrow("`requires` is no longer supported");
  });

  it("accepts valid optional fields", () => {
    const evaluation = defineEval({
      description: "A test eval",
      async test(t) {
        await t.send("hello");
      },
      timeoutMs: 30000,
      tags: ["tag1"],
      metadata: { suite: "smoke" },
    });

    expect(evaluation.description).toBe("A test eval");
    expect(evaluation.timeoutMs).toBe(30000);
    expect(evaluation.tags).toEqual(["tag1"]);
    expect(evaluation.metadata).toEqual({ suite: "smoke" });
  });
});

function typeOnlyFixtures(): void {
  // @ts-expect-error Evals must provide a `test` function.
  defineEval({ description: "missing test" });

  defineEval({
    async test(t) {
      await t.send("hello");
    },
  });
}

void typeOnlyFixtures;
