import { defineAgent } from "eve";
import { defineDynamic } from "eve/models";
import { mockModel } from "eve/evals";

import { respondAsSurveyWorker } from "../../lib/survey.js";

const workerModel = mockModel({ modelId: "survey-worker", respond: respondAsSurveyWorker });

/** Counts Alice's survey stations in one model call whose usage exceeds the parent's budget. */
export default defineAgent({
  description:
    "Test fixture: counts Alice's tide survey stations. Call it only for SURVEY-DELEGATE directives.",
  // Selected per step: in mock mode this fixture replaces static authored
  // models with eve's bootstrap mock, which would drop the worker's usage.
  model: defineDynamic({
    select: () => null,
    resolve: () => ({ model: workerModel, modelContextWindowTokens: 1_000_000 }),
  }),
});
