import type { Experimental_DecisionModel } from "ai";
import { defineDynamic } from "eve";
import { defineState } from "eve/context";
import { mockModel, type MockModelResponder } from "eve/evals";
import { auto } from "eve/models";

export const routing = defineState("decide-fixture.routing", () => ({
  requests: 0,
  model: "unselected",
  reasoning: "unselected",
}));

export const permissionDecisionModel: Exclude<Experimental_DecisionModel, string> = {
  specificationVersion: "v4",
  provider: "fixture",
  modelId: "fixture-permission-decider",
  supportedQuestionTypes: ["choice"],
  async doDecide({ state }) {
    const choice = JSON.stringify(state).includes('"effect":"malicious"') ? "caution" : "clear";
    return {
      answers: { permission: { type: "choice", choice } },
      usage: { inputTokens: 20, outputTokens: 1 },
      warnings: [],
    };
  },
};

export const decisionModel: Exclude<Experimental_DecisionModel, string> = {
  specificationVersion: "v4",
  provider: "fixture",
  modelId: "fixture-decider",
  supportedQuestionTypes: ["choice"],
  async doDecide({ state, questions }) {
    routing.update((value) => ({ ...value, requests: value.requests + 1 }));
    const serialized = JSON.stringify(state);
    if (serialized.includes("service unavailable")) {
      throw new Error("Decision service unavailable.");
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
      response: { modelId: "fixture-decider" },
    };
  },
};

/** Run the real router with deterministic decision and language models. */
export function fixtureModel(respond: MockModelResponder) {
  const model = auto({
    model: decisionModel,
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
