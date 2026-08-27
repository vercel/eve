import { e2eAgentConfig, MOCK_MODEL_SENTINEL } from "@eve-e2e/config";
import { defineAgent, defineDynamic } from "eve";

const requestedModel = process.env.EVE_E2E_MODEL;
const selectedModel =
  requestedModel === undefined || requestedModel === MOCK_MODEL_SENTINEL
    ? "openai/gpt-5.6-sol"
    : requestedModel;

if (requestedModel === MOCK_MODEL_SENTINEL) {
  process.env.EVE_MOCK_AUTHORED_MODELS = "1";
}

const { experimental } = e2eAgentConfig({
  agentStepsPerWorkflowStep: process.env.EVE_E2E_WORKFLOW_WORLD === undefined ? 5 : 1,
});

export default defineAgent({
  experimental,
  model: defineDynamic({
    events: {
      "session.started": (_event, ctx) => {
        if (ctx.messages.length > 0) {
          throw new Error(
            "session.started dynamic model resolver ran after session history existed",
          );
        }

        return {
          model: selectedModel,
          modelContextWindowTokens: 1_000_000,
        };
      },
    },
  }),
});
