import { createAnthropic } from "@ai-sdk/anthropic";
import { type AgentDefinition, defineAgent } from "eve";

/**
 * Prompt-cache e2e fixture.
 *
 * The harness only places explicit cache breakpoints when the model is a
 * provider instance with an Anthropic provider name (`anthropic-direct` in
 * `detectPromptCachePath`). Gateway model id strings take `gateway-auto`,
 * where the gateway caches on its own and the breakpoint code never runs,
 * so a breakpoint regression could not fail an eval there. That is why this
 * fixture authors a direct `@ai-sdk/anthropic` instance while every other
 * fixture uses a gateway string.
 *
 * CI has no `ANTHROPIC_API_KEY`, so the instance points at the AI Gateway's
 * Anthropic-compatible Messages endpoint, which honors `cache_control` and
 * passes `cache_read_input_tokens` / `cache_creation_input_tokens` through
 * unchanged. The same AI Gateway credential as every other fixture is sent
 * as a bearer token: `AI_GATEWAY_API_KEY` takes precedence, with
 * `VERCEL_OIDC_TOKEN` as the fallback.
 */
const anthropic = createAnthropic({
  baseURL: "https://ai-gateway.vercel.sh/v1",
  authToken: process.env.AI_GATEWAY_API_KEY ?? process.env.VERCEL_OIDC_TOKEN ?? "unset",
});

const agent: AgentDefinition = defineAgent({
  model: anthropic("anthropic/claude-haiku-4-5"),
  modelContextWindowTokens: 200_000,
});

export default agent;
