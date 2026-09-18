import type { Experimental_EvaluationModel } from "ai";
import { defineEval } from "eve/evals";

const model: Exclude<Experimental_EvaluationModel, string> = {
  specificationVersion: "v4",
  provider: "fixture",
  modelId: "fixture-judge",
  supportedQuestionTypes: ["boolean", "score", "choice"],
  async doEvaluate({ state, questions }) {
    const routine = JSON.stringify(state).includes("openai/small");
    return {
      answers: Object.fromEntries(
        Object.entries(questions).map(([id, question]) => {
          if (question.type === "boolean")
            return [id, { type: "boolean", probability: routine ? 0.9 : 0.1 }];
          if (question.type === "score") return [id, { type: "score", score: routine ? 1.5 : 0 }];
          return [id, { type: "choice", choice: routine ? "small" : "large" }];
        }),
      ),
      usage: { inputTokens: 20, outputTokens: 3 },
      warnings: [],
    };
  },
};

export default defineEval({
  description: "Single and batched judges score a fixture response through an evaluation model.",
  judge: { model },
  async test(t) {
    const turn = await t.send("Alice needs a routine summary of the selected model.");
    turn.expectOk();
    turn.messageIncludes("openai/small");
    t.judge("The response selects the small model for Alice's routine request.").gate(0.8);
    t.judge({
      type: "score",
      instructions: "Rate whether the response identifies the selected model.",
      criteria: ["Missing", "Partly identified", "Fully identified"],
    }).gate(0.75);
    const judgments = t.judge({
      state: { response: turn.message ?? "" },
      questions: {
        identifiesModel: {
          type: "boolean",
          instructions: "Does the response identify the small model?",
        },
        route: {
          type: "choice",
          instructions: "Which model does the response identify?",
          criteria: { small: "The small model", large: "The large model" },
          expected: "small",
        },
      },
    });
    judgments.identifiesModel.gate(0.8);
    judgments.route.gate();
    t.judge("The conversation identifies the small model.", { on: turn.session.transcript }).gate(
      0.8,
    );
  },
});
