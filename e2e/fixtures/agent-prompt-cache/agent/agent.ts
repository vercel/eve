import { createAnthropic } from "@ai-sdk/anthropic";
import { type AgentDefinition, defineAgent } from "eve";
import { vercelOidc } from "eve/agents/auth";

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
 * as a bearer token: `AI_GATEWAY_API_KEY` takes precedence, with request-scoped
 * Vercel OIDC as the fallback.
 */
const resolveVercelOidc = vercelOidc();
const matrixModel = process.env.EVE_E2E_MODEL ?? "anthropic/claude-opus-4.8";
const promptCacheModel = matrixModel.startsWith("anthropic/")
  ? matrixModel
  : "anthropic/claude-opus-4.8";

const anthropic = createAnthropic({
  baseURL: "https://ai-gateway.vercel.sh/v1",
  // The fetch hook replaces this placeholder with a current Gateway credential.
  authToken: "resolved-per-request",
  fetch: async (input, init) => {
    const headers = new Headers(init?.headers);
    const apiKey = process.env.AI_GATEWAY_API_KEY?.trim();
    const authorization = apiKey
      ? `Bearer ${apiKey}`
      : (await resolveVercelOidc()).headers.authorization;

    headers.set("authorization", authorization);
    return fetch(input, { ...init, headers });
  },
});

const agent: AgentDefinition = defineAgent({
  model: anthropic(promptCacheModel),
  modelContextWindowTokens: 200_000,
});

export default agent;
