import { defineAgent } from "eve";
import { nestedBackgroundModel } from "../../lib/nested-background-model.js";

export default defineAgent({
  description: "Complete Alice's nested verification after she releases the worker.",
  model: nestedBackgroundModel,
  modelContextWindowTokens: 1_000_000,
});
