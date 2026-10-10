import type { Experimental_DecisionModel } from "ai";
import { defineDynamic } from "eve";
import { mockModel, type MockModelRequest, type MockModelResponder } from "eve/evals";
import { auto } from "eve/models";

/** What the router chose for a session's latest message, and how many times it has decided. */
export interface Routing {
  readonly model: string;
  readonly reasoning: string;
  readonly requests: number;
}

/** Decisions per session. `resolve` reads only its selection, so the count lives beside it. */
const decisions = new Map<string, number>();

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

/**
 * Run the real router with deterministic decision and language models. `respond` receives the
 * routing the model it answers for was chosen with: each decision binds a model to it.
 */
export function fixtureModel(
  respond: (
    request: MockModelRequest,
    routing: Routing,
  ) => ReturnType<MockModelResponder>,
) {
  const unused: MockModelResponder = () => "unused";
  const model = auto({
    model: decisionModel,
    options: {
      "openai/large": {
        model: mockModel({ modelId: "openai/large", respond: unused }),
        description: "Difficult investigations",
        reasoning: "high",
      },
      "openai/small": {
        model: mockModel({ modelId: "openai/small", respond: unused }),
        description: "Routine requests",
        reasoning: "low",
      },
    },
  });
  return defineDynamic({
    select: model.select,
    resolve: async (state, ctx) => {
      const selected = await model.resolve(state, ctx);
      const selection =
        typeof selected === "object" && "model" in selected ? selected : { model: selected };
      const requests = (decisions.get(ctx.session.id) ?? 0) + 1;
      decisions.set(ctx.session.id, requests);
      const modelId =
        typeof selection.model === "string" ? selection.model : selection.model.modelId;
      const routing: Routing = {
        model: modelId,
        reasoning: selection.reasoning ?? "provider-default",
        requests,
      };
      return {
        ...selection,
        model: mockModel({ modelId, respond: (request) => respond(request, routing) }),
        modelContextWindowTokens: 1_000_000,
      };
    },
  });
}
