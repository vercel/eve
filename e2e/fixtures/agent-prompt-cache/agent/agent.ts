import { e2eAgentConfig } from "@eve-e2e/config";
import { defineAgent } from "eve";

const config = e2eAgentConfig();

export default defineAgent({
  ...config,
  // Cache locality belongs to the serving provider, not the gateway model id.
  modelOptions:
    typeof config.model === "string" && config.model.startsWith("anthropic/")
      ? { providerOptions: { gateway: { only: ["anthropic"] } } }
      : undefined,
  reasoning: "high",
  limits: { maxInputTokensPerSession: 300_000 },
});
