import type { EveEvalConfig, EveEvalConfigInput, EveEvalSetupResult } from "#evals/types.js";

/**
 * Defines the run-wide configuration shared by every eval, authored as the
 * default export of `evals.config.ts` at the root of the `evals/` directory.
 *
 * Exactly one `evals.config.ts` is required. It supplies the optional default
 * `judge` model for `t.judge(...)` assertions (so individual evals need not
 * repeat it), run-level `reporters`, `maxConcurrency` and `timeoutMs` defaults,
 * and optional run-wide `setup` and `teardown`. CLI flags (`--max-concurrency`,
 * `--timeout`) and per-eval values take precedence over the config defaults.
 *
 * Throws on invalid input: a non-positive or non-integer `maxConcurrency`,
 * a negative or non-finite `timeoutMs`, non-array `reporters`, or a
 * non-function `setup` or `teardown`.
 */
export function defineEvalConfig<TResult extends void | EveEvalSetupResult = void>(
  input: EveEvalConfigInput<TResult>,
): EveEvalConfig<TResult> {
  validateEvalConfigInput(input);

  return {
    ...input,
    _tag: "EveEvalConfig",
  };
}

function validateEvalConfigInput(input: EveEvalConfigInput): void {
  if (input.setup !== undefined && typeof input.setup !== "function") {
    throw new Error("Eval config `setup` must be a function.");
  }

  if (input.teardown !== undefined && typeof input.teardown !== "function") {
    throw new Error("Eval config `teardown` must be a function.");
  }

  if (
    input.maxConcurrency !== undefined &&
    (!Number.isInteger(input.maxConcurrency) || input.maxConcurrency < 1)
  ) {
    throw new Error("Eval config `maxConcurrency` must be a positive integer.");
  }

  if (input.timeoutMs !== undefined && (input.timeoutMs < 0 || !Number.isFinite(input.timeoutMs))) {
    throw new Error("Eval config `timeoutMs` must be a non-negative finite number.");
  }

  if (input.reporters !== undefined && !Array.isArray(input.reporters)) {
    throw new Error("Eval config `reporters` must be an array of reporters.");
  }
}
