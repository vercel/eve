import { defineAgent } from "eve";
import { mockModel } from "eve/evals";

/** Asks which environment a release goes to, then reports the answer it got. */
export default defineAgent({
  description: "Ask which environment the release should go to, then report the choice.",
  model: mockModel(({ toolResults }) => {
    const answer = toolResults.find((entry) => entry.name === "ask_question");
    if (answer !== undefined) return `QUESTION-CHILD-RESULT ${JSON.stringify(answer.output)}`;
    return {
      toolCalls: [
        {
          input: {
            options: [
              { description: "Release to staging first.", label: "Staging" },
              { description: "Release straight to production.", label: "Production" },
            ],
            question: "Which environment should the release go to?",
          },
          name: "ask_question",
        },
      ],
    };
  }),
  modelContextWindowTokens: 1_000_000,
});
