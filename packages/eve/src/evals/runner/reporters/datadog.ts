import type { EvalReporter } from "#evals/runner/reporters/types.js";
import type { EveEval, EveEvalResult, EveEvalRunSummary, EveEvalTarget } from "#evals/types.js";

/**
 * Creates an experimental Datadog reporter skeleton.
 *
 * The reporter is intentionally a no-op while the Datadog integration is
 * developed.
 */
export function Datadog(): EvalReporter {
  return new DatadogReporter();
}

class DatadogReporter implements EvalReporter {
  onRunStart(_evaluations: readonly EveEval[], _target: EveEvalTarget): void {
    // Create one Datadog Experiment for this eval run.
  }

  onEvalComplete(_result: EveEvalResult): void {
    // Associate this eval's runtime span with the Experiment and submit its result and scores.
  }

  onRunComplete(_summary: EveEvalRunSummary): void {
    // Flush pending telemetry and finalize the Datadog Experiment.
  }
}
