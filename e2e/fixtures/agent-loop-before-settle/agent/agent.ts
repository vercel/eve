import { e2eAgentConfig } from "@eve-e2e/config";
import { defineAgent, type DefinedAgent } from "eve";
import { mockModel } from "eve/evals";

const CITATION_NOTE = "Cite a source for the claim, as [1].";

/** Answers without a citation until it reads the critic's note. */
const model = mockModel({
  modelId: "before-settle-model",
  respond(request) {
    return request.lastUserMessage === CITATION_NOTE
      ? "Two court rulings back the second claim [1]."
      : "Two court rulings back the second claim.";
  },
});

const agent: DefinedAgent = defineAgent({
  ...e2eAgentConfig(),
  model,
  experimental: {
    loop: {
      // A critic: a reply without a citation goes back to the model with a note.
      beforeSettle(turn) {
        if (typeof turn.output === "string" && !/\[\d+\]/.test(turn.output)) {
          return { continue: { note: CITATION_NOTE } };
        }
        return undefined;
      },
    },
  },
});

export default agent;
