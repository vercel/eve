import { defineAgent } from "eve";
import { mockModel } from "eve/evals";

export default defineAgent({
  description: "Return the child's advertised tool names in its final report to the parent.",
  model: mockModel(({ tools }) =>
    JSON.stringify({
      result: "TASK-CHILD-FINAL-RESULT",
      tools: tools.map((tool) => tool.name).sort(),
    }),
  ),
  modelContextWindowTokens: 1_000_000,
});
