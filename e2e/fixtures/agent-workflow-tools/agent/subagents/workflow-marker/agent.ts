import { defineAgent } from "eve";
import { mockModel } from "eve/evals";

export default defineAgent({
  description: "Return deterministic markers for workflow-subagent e2e coverage.",
  model: mockModel(({ lastUserMessage }) => `WORKFLOW-CHILD:${lastUserMessage ?? ""}`),
  modelContextWindowTokens: 1_000_000,
  // Fanout evals read ended child histories to verify their trace relationships.
  experimental: { workflow: { retention: "default" } },
});
