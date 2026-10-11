import { decide } from "eve/ai";
import { defineTool } from "eve/tools";

import { decisionModel } from "../testing";

export default defineTool({
  description: "Decide Alice's request with the fixture decision provider.",
  inputSchema: {
    type: "object",
    properties: { missingAnswer: { type: "boolean" } },
    required: ["missingAnswer"],
    additionalProperties: false,
  },
  async execute({ missingAnswer }, ctx) {
    const result = await decide({
      model: missingAnswer
        ? { ...decisionModel, doDecide: async () => ({ answers: {}, warnings: [] }) }
        : decisionModel,
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
