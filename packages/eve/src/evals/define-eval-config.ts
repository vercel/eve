import type { EveEvalConfig, EveEvalConfigInput } from "#evals/types.js";

/**
 * Defines the run-wide configuration shared by every eval, authored as the
 * default export of `evals.config.ts` at the root of the `evals/` directory.
 *
 * Exactly one `evals.config.ts` is required. It supplies the optional default
 * `judge` model for `t.judge(...)` assertions (so individual evals need not
 * repeat it), run-level `reporters`, `maxConcurrency`, `timeoutMs`, and `repeat`
 * defaults, optional run-wide `setup` and `teardown`, and the `targetAuth`
 * credentials sent to the target. CLI flags
 * (`--max-concurrency`, `--timeout`, `--repeat`) and per-eval values take
 * precedence over the config defaults.
 *
 * Throws on invalid input: a non-positive or non-integer `maxConcurrency` or `repeat`,
 * a negative or non-finite `timeoutMs`, non-array `reporters`, a
 * non-function `setup` or `teardown`, or a `targetAuth` without exactly one of
 * `bearer`, `basic`, or `vercelOidc`.
 */
export function defineEvalConfig<TContext = undefined>(
  input: EveEvalConfigInput<TContext>,
): EveEvalConfig<TContext> {
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

  if (input.repeat !== undefined && (!Number.isInteger(input.repeat) || input.repeat < 1)) {
    throw new Error("Eval config `repeat` must be a positive integer.");
  }

  if (input.reporters !== undefined && !Array.isArray(input.reporters)) {
    throw new Error("Eval config `reporters` must be an array of reporters.");
  }

  if (input.targetAuth !== undefined && !isTargetAuth(input.targetAuth)) {
    throw new Error(
      "Eval config `targetAuth` must set exactly one of `bearer`, `basic`, or `vercelOidc`, as in `{ bearer: () => getToken() }`.",
    );
  }
}

function isTargetAuth(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const schemes = ["bearer", "basic", "vercelOidc"].filter((key) => key in value);
  return schemes.length === 1;
}
