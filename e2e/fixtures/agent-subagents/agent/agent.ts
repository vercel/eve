import { e2eAgentConfig } from "@eve-e2e/config";
import { defineAgent } from "eve";

if (process.env.EVE_E2E_MODEL === "mock") {
  process.env.EVE_MOCK_AUTHORED_MODELS = "1";
}

const base = e2eAgentConfig();

export default defineAgent({
  ...base,
  reasoning: "high",
});
