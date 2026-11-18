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
import type { EvalSessionStartedEvent } from "#evals/session.js";
import { computeEvalVerdict } from "#evals/runner/verdict.js";

export interface ExecuteEvalOptions {
  readonly evaluation: EveEval;
  readonly onLog?: (message: string) => void;
  readonly onSessionStart?: (event: EvalSessionStartedEvent) => void;
  readonly setupContext?: unknown;
  readonly target: EveEvalTargetHandle;
  readonly timeoutMs?: number;
  readonly startedAt?: string;
  readonly client: Client;
}

export async function executeEval(options: ExecuteEvalOptions): Promise<EveEvalResult> {
  const { evaluation, target, client } = options;
  const startedAt = options.startedAt ?? new Date().toISOString();

  let result: EveEvalTaskResult;
  let assertions: readonly AssertionResult[] = [];
  let error: string | undefined;
  let skipReason: string | undefined;

  try {
    const outcome = await executeTask({
      client,
      evaluation,
      setupContext: options.setupContext,
      onLog: options.onLog,
      onSessionStart: options.onSessionStart,
      target,
      timeoutMs: options.timeoutMs ?? evaluation.timeoutMs,
    });
    result = outcome.result;
    assertions = outcome.assertions;
    error = outcome.error;
    skipReason = outcome.skipReason;
  } catch (err) {
    error = toErrorMessage(err);
    result = {
      data: undefined,
      reply: undefined,
      sessionEnded: false,
      status: "failed",
      events: [],
      derived: createEmptyDerivedFacts(),
      traceContexts: [],
    };
  }

  const verdict = computeEvalVerdict({ error, assertions, skipReason });

  return {
    id: evaluation.id,
    result,
    assertions,
    verdict,
    error,
    skipReason,
    startedAt,
    completedAt: new Date().toISOString(),
  };
}
