import { deriveSelfModificationLifecycle } from "../scripts/eval-experiments/measurements/self-modification-lifecycle.mjs";

/** @satisfies {import('../scripts/eval-experiments/types.ts').MeasurementBundle} */
export const selfModificationMetrics = {
  version: 3,
  metrics: {
    parentTurnToFinalChildCompletion: { unit: "ms", direction: "lower" },
    totalChildDuration: { unit: "ms", direction: "lower" },
    toolCalls: { unit: "count", direction: "neutral" },
  },
  derive(captured) {
    return deriveSelfModificationLifecycle(captured.result.sessions);
  },
};
