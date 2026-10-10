import { e2eAgentConfig, MOCK_MODEL_SENTINEL } from "@eve-e2e/config";
import { defineAgent } from "eve";
import { defineDynamic } from "eve/models";

const requestedModel = process.env.EVE_E2E_MODEL;
const selectedModel =
  requestedModel === undefined || requestedModel === MOCK_MODEL_SENTINEL
    ? "openai/gpt-6.1-sol"
    : requestedModel;

if (requestedModel === MOCK_MODEL_SENTINEL) {
  process.env.EVE_MOCK_AUTHORED_MODELS = "1";
}

const { experimental } = e2eAgentConfig();

// A select of null resolves the model once, after the session's first commit.
export default defineAgent({
  experimental,
  model: defineDynamic({
    select: () => null,
    resolve: () => ({ model: selectedModel, modelContextWindowTokens: 1_000_000 }),
  }),
});
