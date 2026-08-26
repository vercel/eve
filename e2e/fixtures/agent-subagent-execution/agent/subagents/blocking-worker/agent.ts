import { defineLocalSubagent } from "eve";
import { mockModel } from "eve/evals";

export default defineLocalSubagent({
  background: false,
  description: "Return a deterministic blocking result.",
  model: mockModel("MIXED-BLOCKING-RESULT"),
  modelContextWindowTokens: 1_000_000,
});
