import type { EveEvalDefinition, EveEvalInput } from "#evals/types.js";

/**
 * Defines one eve eval. Each eval file is exactly one case: an imperative
 * `test(t)` function that drives the agent (`t.send`, `t.respond`, …) and
 * asserts on what it produced (`t.succeeded()`, `t.check(...)`,
 * `t.judge.autoevals.*`). Organize related evals with directory nesting under
 * `evals/`, or default-export an array of evals to fan one file out over a
 * dataset.
 *
 * A `judge` is optional: `t.judge.*` assertions fall back to the `judge`
 * declared in `evals.config.ts` unless this eval overrides it. The judge model
 * is used solely for scoring, never for the agent under test. Eval identity is
 * derived from the `evals/<path>.eval.ts` file path by the discovery layer, so
 * authoring `id` or `name` throws.
 *
 * Throws on invalid input: a missing `test` function, a removed legacy key
 * (`input`/`run`/`checks`/`scores`/`expected`/`thresholds`/`parseOutput`/
 * `model`/`requires`), or a negative or non-finite `timeoutMs`.
 */
export function defineEval(input: EveEvalInput): EveEvalDefinition {
  validateEvalInput(input);

  return {
    ...input,
    _tag: "EveEval",
  };
}

function validateEvalInput(input: EveEvalInput): void {
  if ("id" in input) {
    throw new Error(
      "Eval must not specify `id`. Eval identity is derived from the file path under evals/.",
    );
  }

  if ("name" in input) {
    throw new Error(
      "Eval must not specify `name`. Eval identity is derived from the file path under evals/.",
    );
  }

  rejectLegacyKey(
    input,
    "input",
    "Send the prompt inside `test`: `async test(t) { await t.send(...) }`.",
  );
  rejectLegacyKey(input, "run", "Rename `run` to `test`; it receives the same context `t`.");
  rejectLegacyKey(
    input,
    "checks",
    "Assert inline inside `test` (e.g. `t.succeeded()`, `t.calledTool(...)`).",
  );
  rejectLegacyKey(
    input,
    "scores",
    "Use soft assertions inside `test`: `t.check(...).atLeast(n)` or `t.judge.autoevals.*`.",
  );
  rejectLegacyKey(
    input,
    "expected",
    "Pass the reference value to the assertion (e.g. `t.check(t.reply, includes(value))`).",
  );
  rejectLegacyKey(input, "thresholds", "Put the threshold on the assertion: `.atLeast(n)`.");
  rejectLegacyKey(
    input,
    "parseOutput",
    "Read the value you want inside `test` and assert on it directly.",
  );
  rejectLegacyKey(input, "model", "Rename `model` to `judge: { model }`.");
  rejectLegacyKey(input, "modelOptions", "Move it under `judge: { model, modelOptions }`.");
  rejectLegacyKey(
    input,
    "cases",
    "Each eval file is one case; default-export an array of `defineEval(...)` for datasets.",
  );
  rejectLegacyKey(
    input,
    "requires",
    "Point real-model evals at credentialed targets directly; dev-only routes are enforced from the live target.",
  );

  if (typeof input.test !== "function") {
    throw new Error("Eval requires a `test(t)` function.");
  }

  if (input.timeoutMs !== undefined && (input.timeoutMs < 0 || !Number.isFinite(input.timeoutMs))) {
    throw new Error("Eval `timeoutMs` must be a non-negative finite number.");
  }
}

function rejectLegacyKey(input: object, key: string, guidance: string): void {
  if (key in input) {
    throw new Error(`Eval \`${key}\` is no longer supported. ${guidance}`);
  }
}
