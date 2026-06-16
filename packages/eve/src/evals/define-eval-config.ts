import type { EveEvalConfig, EveEvalConfigInput } from "#evals/types.js";

/**
 * Defines the run-wide configuration shared by every eval, authored as the
 * default export of `evals.config.ts` at the root of the `evals/` directory.
 *
 * Exactly one `evals.config.ts` is required. It supplies the optional default
 * `judge` model for `t.judge.*` assertions (so individual evals need not
 * repeat it), optional run-level `reporters`, a default `maxConcurrency`, and a
 * default `timeoutMs`. CLI flags (`--max-concurrency`, `--timeout`) and
 * per-eval values take precedence over the config defaults.
 *
 * Throws on invalid input: a `judge` without a `model`, a non-positive or
 * non-integer `maxConcurrency`, a negative or non-finite `timeoutMs`, or a
 * non-array `reporters`.
 */
export function defineEvalConfig(input: EveEvalConfigInput): EveEvalConfig {
  validateEvalConfigInput(input);

  return {
    ...input,
    _tag: "EveEvalConfig",
  };
}

function validateEvalConfigInput(input: EveEvalConfigInput): void {
  if (
    input.judge !== undefined &&
    (input.judge.model === undefined || input.judge.model === null)
  ) {
    throw new Error(
      "Eval config `judge` requires a `model`. It is the default judge model for `t.judge.*` " +
        "assertions across every eval.",
    );
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
