import { defineAgent, defineDynamic } from "eve";
import { mockModel } from "eve/evals";

import { respondAsLeaseWorker } from "../../lib/lease.js";

const workerModel = mockModel({
  modelId: "lease-worker-b",
  respond: respondAsLeaseWorker("lease-worker-b", 3),
});

export default defineAgent({
  description: "Test fixture: reads survey pages. Call it only for LEASE-FANOUT directives.",
  model: defineDynamic({
    events: {
      "step.started": () => ({ model: workerModel, modelContextWindowTokens: 1_000_000_000 }),
    },
  }),
});
