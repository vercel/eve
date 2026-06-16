import type { EveEval, EveEvalResult, EveEvalRunSummary, EveEvalTarget } from "#evals/types.js";

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
  onRunStart(evaluations: readonly EveEval[], target: EveEvalTarget): void | Promise<void>;

  /**
   * The runner calls this after each observed eval completes, with its
   * checks, scores, and verdict.
   */
  onEvalComplete(result: EveEvalResult): void | Promise<void>;

  /**
   * The runner calls this once when the run finishes, with the aggregated
   * summary of the evals this reporter observes.
   */
  onRunComplete(summary: EveEvalRunSummary): void | Promise<void>;
}
