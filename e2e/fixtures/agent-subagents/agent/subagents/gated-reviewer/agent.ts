import { defineAgent, defineDynamic } from "eve";
import { mockModel } from "eve/evals";

const reviewerModel = mockModel(({ toolResults }) => {
  const result = toolResults.find((candidate) => candidate.id === "review-gate");
  if (result === undefined) {
    return {
      toolCalls: [{ id: "review-gate", input: {}, name: "review_gate" }],
    };
  }
  const output = result.output;
  if (
    output === null ||
    typeof output !== "object" ||
    typeof Reflect.get(output, "verdict") !== "string"
  ) {
    throw new Error("The review gate returned no verdict.");
  }
  return Reflect.get(output, "verdict") as string;
});

export default defineAgent({
  description: "Deterministic reviewer held behind an explicit approval gate.",
  model: defineDynamic({
    events: {
      "step.started": () => ({
        model: reviewerModel,
        modelContextWindowTokens: 1_000_000,
      }),
    },
  }),
});
