import { defineLocalSubagent } from "eve";
import { mockModel } from "eve/evals";

export default defineLocalSubagent({
  background: true,
  description: "Return a deterministic background result.",
  model: mockModel("MIXED-BACKGROUND-RESULT"),
  modelContextWindowTokens: 1_000_000,
});
