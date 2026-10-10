import { e2eAgentConfig, MOCK_MODEL_SENTINEL } from "@eve-e2e/config";
import { defineAgent, defineDynamic } from "eve";

const requestedModel = process.env.EVE_E2E_MODEL;
const selectedModel =
  requestedModel === undefined || requestedModel === MOCK_MODEL_SENTINEL
    ? "openai/gpt-6.1-sol"
    : requestedModel;

if (requestedModel === MOCK_MODEL_SENTINEL) {
  process.env.EVE_MOCK_AUTHORED_MODELS = "1";
}

const { experimental } = e2eAgentConfig();

// Without a select, the dynamic agent resolves once, after the session's first commit.
export default defineDynamic({
  experimental,
  resolve: () => defineAgent({ model: selectedModel, modelContextWindowTokens: 1_000_000 }),
});
