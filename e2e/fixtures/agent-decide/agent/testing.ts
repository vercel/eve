import type { Experimental_DecisionModel } from "ai";
import { mockModel, type MockModelRequest, type MockModelResponder } from "eve/evals";
import { auto } from "eve/models";

/** What the router chose for a turn, and how many times it decided for the turn's input. */
export interface Routing {
  readonly model: string;
  readonly reasoning: string;
  readonly decisions: number;
}

/**
 * Decisions by the input they routed: a turn that decides once reports 1, in a warm process or a
 * fresh one. Process-local, as the eval host is.
 */
const decisions = new Map<string, number>();

/** The latest user text the router decided on. */
function routedInput(userMessages: readonly string[]): string | undefined {
  return [...userMessages].reverse().find((text) => decisions.has(text));
}

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
    const input = (state as { messages: { text: string }[] }).messages.at(-1)?.text ?? "";
    decisions.set(input, (decisions.get(input) ?? 0) + 1);
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
 * The real router, with deterministic decision and language models. `respond` receives the
 * routing the model answering was chosen with: each option's model knows its own.
 */
export function fixtureModel(
  respond: (request: MockModelRequest, routing: Routing) => ReturnType<MockModelResponder>,
) {
  const option = (model: string, reasoning: "high" | "low", description: string) => ({
    description,
    model: mockModel({
      modelId: model,
      respond: (request) =>
        respond(request, {
          decisions: decisions.get(routedInput(request.userMessages) ?? "") ?? 0,
          model,
          reasoning,
        }),
    }),
    modelContextWindowTokens: 1_000_000,
    reasoning,
  });
  return auto({
    model: decisionModel,
    options: {
      "openai/large": option("openai/large", "high", "Difficult investigations"),
      "openai/small": option("openai/small", "low", "Routine requests"),
    },
  });
}
