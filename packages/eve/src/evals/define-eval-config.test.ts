import { describe, expect, expectTypeOf, it } from "vitest";

import { defineEvalConfig } from "#evals/define-eval-config.js";
import { defineEval } from "#evals/define-eval.js";
import type { EveEvalConfigInput } from "#evals/types.js";

const TEST_MODEL = "openai/gpt-5.4-mini";

function defineInvalidConfig(input: Partial<EveEvalConfigInput> & Record<string, unknown>): void {
  defineEvalConfig(input as EveEvalConfigInput);
}

describe("defineEvalConfig", () => {
  it("infers setup context for teardown and evals", () => {
    class Database {
      query() {
        return 42;
      }
    }
    const config = defineEvalConfig({
      async setup() {
        return { context: { database: new Database() } };
      },
      teardown(context) {
        expectTypeOf(context).toEqualTypeOf<{ database: Database } | undefined>();
      },
    });
    const evaluation = defineEval<typeof config>({
      test(t) {
        expectTypeOf(t.context).toEqualTypeOf<{ database: Database }>();
        expectTypeOf(t.context.database.query()).toEqualTypeOf<number>();
      },
    });
    expect(evaluation._tag).toBe("EveEval");
  });

  it("infers undefined when setup returns only environment values", () => {
    const config = defineEvalConfig({
      setup() {
        return { env: { DATABASE_URL: "test" } };
      },
      teardown(context) {
        expectTypeOf(context).toEqualTypeOf<undefined>();
      },
    });
    defineEval<typeof config>({
      test(t) {
        expectTypeOf(t.context).toEqualTypeOf<undefined>();
      },
    });
  });

  it("preserves optional context when setup may return nothing", () => {
    const config = defineEvalConfig({
      setup(): { context: Map<string, number> } | void {},
      teardown(context) {
        expectTypeOf(context).toEqualTypeOf<Map<string, number> | undefined>();
      },
    });
    defineEval<typeof config>({
      test(t) {
        expectTypeOf(t.context).toEqualTypeOf<Map<string, number> | undefined>();
      },
    });
  });

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

  it("allows judge settings to use the default evaluation model", () => {
    expect(defineEvalConfig({ judge: {} }).judge).toEqual({});
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

  it("rejects a non-function teardown", () => {
    expect(() => defineInvalidConfig({ teardown: {} as never })).toThrow(
      "`teardown` must be a function",
    );
  });

  it("rejects a non-function setup", () => {
    expect(() => defineInvalidConfig({ setup: {} as never })).toThrow("`setup` must be a function");
  });
});
