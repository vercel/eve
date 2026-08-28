import { randomUUID } from "node:crypto";

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

/**
 * Options for executing one eval.
 */
export interface ExecuteEvalOptions {
  /** Unique identity for this execution of the eval case. */
  readonly caseId?: string;
  readonly evaluation: EveEval;
  /** Runner-owned identity propagated into every session created by this eval. */
  readonly runId?: string;
  /** Receives `t.log` lines as the eval runs (used by `--verbose`). */
  readonly onLog?: (message: string) => void;
  /** Receives the first trace context observed for each session. */
  readonly onSessionStart?: (event: EvalSessionStartedEvent) => void;
  readonly target: EveEvalTargetHandle;
  /** Overrides the eval's own `timeoutMs` when set (CLI `--timeout`). */
  readonly timeoutMs?: number;
  /** Runner-owned start time, shared with reporter lifecycle events. */
  readonly startedAt?: string;
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
  const caseId = options.caseId ?? randomUUID();
  const runId = options.runId ?? randomUUID();
  const startedAt = options.startedAt ?? new Date().toISOString();

  let result: EveEvalTaskResult;
  let assertions: readonly AssertionResult[] = [];
  let error: string | undefined;
  let skipReason: string | undefined;

  try {
    const outcome = await executeTask({
      client,
      evalIdentity: { evalId: caseId, runId },
      evaluation,
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
      output: null,
      finalMessage: null,
      status: "failed",
      events: [],
      derived: createEmptyDerivedFacts(),
      traceContexts: [],
    };
  }

  const verdict = computeEvalVerdict({ error, assertions, skipReason });

  return {
    caseId,
    id: evaluation.id,
    runId,
    result,
    assertions,
    verdict,
    error,
    skipReason,
    startedAt,
    completedAt: new Date().toISOString(),
  };
}
