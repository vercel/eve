import { createAnthropic } from "@ai-sdk/anthropic";
import { type AgentDefinition, defineAgent } from "eve";

/**
 * Prompt-cache e2e fixture.
 *
 * Uses a direct `@ai-sdk/anthropic` model instance (not a gateway model id
 * string) so the harness takes the `anthropic-direct` prompt-cache path and
 * places explicit cache breakpoints. The instance points at the AI Gateway's
 * Anthropic-compatible Messages endpoint, which passes Anthropic cache
 * accounting (`cache_read_input_tokens` / `cache_creation_input_tokens`)
 * through unchanged, so the suite runs on the same `AI_GATEWAY_API_KEY`
 * credential as every other fixture. `VERCEL_OIDC_TOKEN` is the local-dev
 * fallback; the gateway accepts both as the `x-api-key` value.
 */
const anthropic = createAnthropic({
  baseURL: "https://ai-gateway.vercel.sh/v1",
  apiKey: process.env.AI_GATEWAY_API_KEY ?? process.env.VERCEL_OIDC_TOKEN ?? "unset",
});

const agent: AgentDefinition = defineAgent({
  model: anthropic("anthropic/claude-haiku-4-5"),
  modelContextWindowTokens: 200_000,
});

export default agent;
