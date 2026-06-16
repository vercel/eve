import type { Client } from "#client/client.js";
import { toErrorMessage } from "#shared/errors.js";
import type {
  AssertionResult,
  EveEval,
  EveEvalResult,
  EveEvalTargetHandle,
  EveEvalTaskResult,
} from "#evals/types.js";
import { createEmptyDerivedFacts } from "#evals/runner/derive-run-facts.js";
import { executeTask } from "#evals/runner/execute-task.js";
import { computeEvalVerdict } from "#evals/runner/verdict.js";

/**
 * Options for executing one eval.
 */
export interface ExecuteEvalOptions {
  readonly evaluation: EveEval;
  /** Receives `t.log` lines as the eval runs (used by `--verbose`). */
  readonly onLog?: (message: string) => void;
  readonly target: EveEvalTargetHandle;
  /** Overrides the eval's own `timeoutMs` when set (CLI `--timeout`). */
  readonly timeoutMs?: number;
  /**
   * Pre-configured client for communicating with the eve agent.
   * The CLI constructs this once with the appropriate auth and headers,
   * and every eval creates fresh sessions from it.
   */
  readonly client: Client;
}

/**
 * Executes one eval end to end: runs `test(t)`, collects its assertions, and
 * computes the verdict.
 */
export async function executeEval(options: ExecuteEvalOptions): Promise<EveEvalResult> {
  const { evaluation, target, client } = options;
  const startedAt = new Date().toISOString();

  let result: EveEvalTaskResult;
  let assertions: readonly AssertionResult[] = [];
  let error: string | undefined;

  try {
    const outcome = await executeTask({
      client,
      evaluation,
      onLog: options.onLog,
      target,
      timeoutMs: options.timeoutMs ?? evaluation.timeoutMs,
    });
    result = outcome.result;
    assertions = outcome.assertions;
    error = outcome.error;
  } catch (err) {
    error = toErrorMessage(err);
    result = {
      output: null,
      finalMessage: null,
      status: "failed",
      events: [],
      derived: createEmptyDerivedFacts(),
    };
  }

  const verdict = computeEvalVerdict({ error, assertions });

  return {
    id: evaluation.id,
    result,
    assertions,
    verdict,
    error,
    startedAt,
    completedAt: new Date().toISOString(),
  };
}
