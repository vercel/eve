import { evaluate } from "eve/experimental/evaluate";
import { defineTool } from "eve/tools";

import { evaluationModel } from "../testing";

export default defineTool({
  description: "Evaluate Alice's request with the fixture evaluation provider.",
  inputSchema: {
    type: "object",
    properties: { missingAnswer: { type: "boolean" } },
    required: ["missingAnswer"],
    additionalProperties: false,
  },
  async execute({ missingAnswer }, ctx) {
    const result = await evaluate({
      model: missingAnswer
        ? { ...evaluationModel, doEvaluate: async () => ({ answers: {}, warnings: [] }) }
        : evaluationModel,
      state: { request: "Alice needs a routine summary." },
      questions: {
        route: {
          type: "choice",
          instructions: "Choose a model for the request.",
          criteria: {
            "openai/large": "Difficult investigations",
            "openai/small": "Routine requests",
          },
        },
      },
      abortSignal: ctx.abortSignal,
    });
    return { choice: result.answers.route.choice, usage: result.usage };
  },
});
