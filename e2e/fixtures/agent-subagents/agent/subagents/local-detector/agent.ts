import { defineAgent, defineDynamic } from "eve";
import { nestedBackgroundModel } from "../../lib/nested-background-model.js";

export default defineAgent({
  description: "Coordinate Alice's verification using the declared verification-worker.",
  model: defineDynamic({
    events: {
      "step.started": () => ({ model: nestedBackgroundModel, modelContextWindowTokens: 1_000_000 }),
    },
  }),
});
