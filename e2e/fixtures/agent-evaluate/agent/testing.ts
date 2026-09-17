import type { Experimental_EvaluationModel } from "ai";
import { defineDynamic } from "eve";
import { defineState } from "eve/context";
import { mockModel, type MockModelResponder } from "eve/evals";
import { autoModel } from "eve/experimental/evaluate";

export const routing = defineState("evaluate-fixture.routing", () => ({
  requests: 0,
  model: "unselected",
  reasoning: "unselected",
}));

export const evaluationModel: Exclude<Experimental_EvaluationModel, string> = {
  specificationVersion: "v4",
  provider: "fixture",
  modelId: "fixture-evaluator",
  supportedQuestionTypes: ["choice"],
  async doEvaluate({ state, questions }) {
    routing.update((value) => ({ ...value, requests: value.requests + 1 }));
    const serialized = JSON.stringify(state);
    if (serialized.includes("service unavailable")) {
      throw new Error("Evaluation service unavailable.");
    }
    const choice = serialized.includes("difficult") ? "openai/large" : "openai/small";
    return {
      answers: {
        route: {
          type: "choice",
          choice,
          probabilities: Object.fromEntries(
            Object.keys(questions.route!.criteria!).map((key) => [key, key === choice ? 1 : 0]),
          ),
        },
      },
      usage: { inputTokens: 42, outputTokens: 3 },
      warnings: [],
      response: { modelId: "fixture-evaluator" },
    };
  },
};

/** Run the real router with deterministic evaluation and language models. */
export function fixtureModel(respond: MockModelResponder) {
  const model = autoModel({
    model: evaluationModel,
    options: {
      "openai/large": {
        model: mockModel({ modelId: "openai/large", respond }),
        description: "Difficult investigations",
        reasoning: "high",
      },
      "openai/small": {
        model: mockModel({ modelId: "openai/small", respond }),
        description: "Routine requests",
        reasoning: "low",
      },
    },
  });
  return defineDynamic({
    events: {
      "step.started": async (event, ctx) => {
        const selected = await model.events["step.started"]!(event, ctx);
        const selection =
          typeof selected === "object" && "model" in selected ? selected : { model: selected };
        routing.update((value) => ({
          ...value,
          model: typeof selection.model === "string" ? selection.model : selection.model.modelId,
          reasoning: selection.reasoning ?? "provider-default",
        }));
        return {
          ...selection,
          modelContextWindowTokens: 1_000_000,
        };
      },
    },
  });
}
