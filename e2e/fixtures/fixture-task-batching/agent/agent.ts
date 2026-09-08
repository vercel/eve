import { defineAgent } from "eve";
import baseline from "../../fixture-tasks/agent/agent.js";

export default defineAgent({
  model: baseline.model,
  modelContextWindowTokens: baseline.modelContextWindowTokens,
  experimental: { ...baseline.experimental, batchTaskCompletions: true },
});
