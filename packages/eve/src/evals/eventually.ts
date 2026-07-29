import { toErrorMessage } from "#shared/errors.js";
import { AssertionCollector } from "#evals/assertions/collector.js";
import { EvalRequirementFailed } from "#evals/control-flow.js";
import type { Assertion, EveEvalEventuallyOptions } from "#evals/types.js";

const DEFAULT_INTERVAL_MS = 100;
const DEFAULT_TIMEOUT_MS = 5_000;

/** Implements the required retrying assertion exposed as `t.eventually()`. */
export async function requireEventually<T>(input: {
  readonly assertion: Assertion;
  readonly collector: AssertionCollector;
  readonly options?: EveEvalEventuallyOptions;
  readonly sample: () => T | Promise<T>;
  readonly signal: AbortSignal;
}): Promise<T> {
  const intervalMs = input.options?.intervalMs ?? DEFAULT_INTERVAL_MS;
  const timeoutMs = input.options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  validateOptions({ intervalMs, timeoutMs });

  const assertion = input.assertion.gate(input.assertion.threshold);
  const threshold = assertion.threshold ?? 1;
  const deadline = Date.now() + timeoutMs;
  let attempts = 0;
  let lastScore = 0;
  let lastValue: T;

  while (true) {
    input.signal.throwIfAborted();
    attempts += 1;
    lastValue = await input.sample();
    input.signal.throwIfAborted();

    try {
      lastScore = await assertion.score(lastValue);
    } catch (error) {
      input.signal.throwIfAborted();
      await recordScoreError({
        assertion,
        attempts,
        collector: input.collector,
        error,
      });
      throw new EvalRequirementFailed();
    }

    if (lastScore >= threshold) {
      await input.collector.recordRequirement({
        name: `eventually(${assertion.name})`,
        threshold: assertion.threshold,
        score: async () => ({
          score: lastScore,
          metadata: { attempts, timeoutMs },
        }),
      });
      return lastValue;
    }

    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      await input.collector.recordRequirement({
        name: `eventually(${assertion.name})`,
        threshold: assertion.threshold,
        score: async () => ({
          score: lastScore,
          message: `condition did not pass within ${timeoutMs}ms after ${attempts} attempt(s)`,
          metadata: { attempts, lastScore, timeoutMs },
        }),
      });
      throw new EvalRequirementFailed();
    }

    await sleep(Math.min(intervalMs, remainingMs), input.signal);
  }
}

async function recordScoreError(input: {
  readonly assertion: Assertion;
  readonly attempts: number;
  readonly collector: AssertionCollector;
  readonly error: unknown;
}): Promise<void> {
  await input.collector.recordRequirement({
    name: `eventually(${input.assertion.name})`,
    threshold: input.assertion.threshold,
    score: async () => {
      throw new Error(
        `eventual assertion threw on attempt ${input.attempts}: ${toErrorMessage(input.error)}`,
      );
    },
  });
}

function validateOptions(options: {
  readonly intervalMs: number;
  readonly timeoutMs: number;
}): void {
  if (!Number.isFinite(options.intervalMs) || options.intervalMs <= 0) {
    throw new TypeError("eventually() intervalMs must be a positive finite number.");
  }
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs < 0) {
    throw new TypeError("eventually() timeoutMs must be a non-negative finite number.");
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();

  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timeout);
      reject(signal.reason);
    };
    const timeout = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
