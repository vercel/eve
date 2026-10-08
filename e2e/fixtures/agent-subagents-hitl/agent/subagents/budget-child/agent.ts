import { defineAgent } from "eve";
import { mockModel } from "eve/evals";

/**
 * Records one release step on a one-token input budget, so its second model
 * call stops at its budget question, which its parent relays.
 */
export default defineAgent({
  description: "Record the release step, then confirm it.",
  limits: { maxInputTokensPerSession: 1 },
  model: mockModel(({ toolResults }) =>
    toolResults.some((entry) => entry.name === "record_step")
      ? "BUDGET-CHILD-RESULT recorded"
      : { toolCalls: [{ input: {}, name: "record_step" }] },
  ),
  modelContextWindowTokens: 1_000_000,
});
