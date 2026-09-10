import { e2eAgentConfig } from "@eve-e2e/config";
import { defineAgent } from "eve";

const config = e2eAgentConfig();

export default defineAgent({
  ...config,
  experimental: { ...config.experimental, instrumentationProviders: true },
  reasoning: "high",
  limits: { maxInputTokensPerSession: 300_000 },
});
