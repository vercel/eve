import { selfModificationMetrics } from "./self-modification-metrics.mjs";

/** @satisfies {import('../scripts/eval-experiments/types.ts').Experiment} */
export default {
  evals: [
    {
      fixture: "agent-self-modification",
      include: [
        "self-modification/add-agent-browser",
        "self-modification/add-slack-channel",
        "self-modification/create-background-replication-check",
        "self-modification/create-incident-triage",
        "self-modification/create-shipping-quote",
        "self-modification/offer-repair",
        "self-modification/repair-order-total",
      ],
    },
  ],
  matrix: {
    configuration: {
      lunaFastXhigh: {
        selfModification: { model: "openai/gpt-5.6-luna-fast", reasoning: "xhigh" },
      },
      opus55: {
        selfModification: { model: "anthropic/claude-opus-5.5" },
      },
      grok47: {
        selfModification: { model: "spacexai/grok-4.7" },
      },
    },
  },
  measurements: { selfModification: selfModificationMetrics },
  sampling: { repetitions: 2, seed: 42 },
  analysis: {
    compare: { axis: "configuration", baseline: "lunaFastXhigh" },
    primaryMetric: "selfModification.totalChildDuration",
    eligibility: "paired-correct",
  },
};
