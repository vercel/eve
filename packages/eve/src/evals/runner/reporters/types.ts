import type { RuntimeTraceContext } from "#protocol/message.js";
import type {
  EveEval,
  EveEvalResult,
  EveEvalRunSummary,
  EveEvalTarget,
  EveEvalTraceContext,
} from "#evals/types.js";

/** Context delivered when one eval is scheduled for execution. */
export interface EveEvalStartEvent {
  /** Unique identity for this execution of the eval case. */
  readonly caseId: string;
  readonly evaluation: EveEval;
  readonly runId: string;
  readonly startedAt: string;
  readonly target: EveEvalTarget;
}

/** Context delivered once the runner observes a session's first trace. */
export interface EveEvalSessionStartEvent extends EveEvalStartEvent {
  readonly primary: boolean;
  readonly sessionId: string;
  readonly traceContext: RuntimeTraceContext;
}

/** Additional run context delivered with a completed eval result. */
export interface EveEvalCompleteContext {
  readonly caseId: string;
  readonly evaluation: EveEval;
  readonly runId: string;
  readonly target: EveEvalTarget;
  readonly traceContexts: readonly EveEvalTraceContext[];
}

/** Context delivered when one eval run begins. */
export interface EveEvalRunStartContext {
  readonly runId: string;
  readonly startedAt: string;
}

/**
 * Reporter lifecycle interface. The runner calls these methods at defined
 * points during an eval run. Methods may return a promise for reporters
 * that perform asynchronous work (e.g. uploading to a remote service).
 *
 * Run-level reporters (console, JUnit) observe every eval in the run.
 * Eval-defined reporters observe only the evals that reference them.
 */
export interface EvalReporter {
  /**
   * The runner calls this once before any eval executes, with the evals
   * this reporter observes.
   */
  onRunStart(
    evaluations: readonly EveEval[],
    target: EveEvalTarget,
    context?: EveEvalRunStartContext,
  ): void | Promise<void>;

  /** The runner calls this when an observed eval is scheduled. */
  onEvalStart?(event: EveEvalStartEvent): void | Promise<void>;

  /**
   * The runner calls this once per session when its first trace context is
   * observed. Sessions without trace instrumentation do not trigger it.
   */
  onSessionStart?(event: EveEvalSessionStartEvent): void | Promise<void>;

  /**
   * The runner calls this after each observed eval completes, with its
   * checks, scores, and verdict.
   */
  onEvalComplete(result: EveEvalResult, context?: EveEvalCompleteContext): void | Promise<void>;

  /**
   * The runner calls this once when the run finishes, with the aggregated
   * summary of the evals this reporter observes.
   */
  onRunComplete(summary: EveEvalRunSummary): void | Promise<void>;
}
