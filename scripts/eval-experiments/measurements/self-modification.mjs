import { deriveSelfModificationLifecycle } from "./self-modification-lifecycle.mjs";

const selfModificationCases = [
  "self-modification/add-agent-browser",
  "self-modification/add-slack-channel",
  "self-modification/create-background-replication-check",
  "self-modification/create-incident-triage",
  "self-modification/create-shipping-quote",
  "self-modification/offer-repair",
  "self-modification/repair-order-total",
];
const selfModificationCaseSet = new Set(selfModificationCases);

/** @satisfies {import('../types.ts').MeasurementBundle} */
export const selfModificationMetrics = {
  version: 3,
  cases: selfModificationCases,
  metrics: {
    parentTurnToFinalChildCompletion: { unit: "ms", direction: "lower" },
    totalChildDuration: { unit: "ms", direction: "lower" },
    toolCalls: { unit: "count", direction: "neutral" },
  },
  derive(captured) {
    return deriveSelfModificationMetrics(captured.id, captured.result.sessions);
  },
};

export function deriveSelfModificationMetrics(evalId, sessions) {
  if (!selfModificationCaseSet.has(evalId)) {
    const notApplicable = {
      status: /** @type {const} */ ("not-applicable"),
      reason: "unsupported-eval",
    };
    return {
      parentTurnToFinalChildCompletion: notApplicable,
      totalChildDuration: notApplicable,
      toolCalls: notApplicable,
    };
  }
  return deriveSelfModificationLifecycle(sessions);
}
