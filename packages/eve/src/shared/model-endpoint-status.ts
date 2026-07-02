import { z } from "#compiled/zod/index.js";

/**
 * How the agent reaches its model and whether it's ready: the build-time model
 * auth/routing facts composed with runtime credential presence. A client (the
 * dev TUI status bar, or any other consumer of `/eve/v1/info`) shows and gates
 * on these states:
 *
 * - `codex` + `connected: true`: authenticated through a local Codex login
 *   state that has a usable API key, fresh ChatGPT access token, or ChatGPT
 *   refresh token.
 * - `codex` + `connected: false`: configured for Codex, but the local Codex
 *   login state is missing, invalid, or cannot refresh an expired access token.
 * - `external`: a model configuration outside AI Gateway. It can use a
 *   provider or a router such as OpenRouter. eve makes no connectedness claim
 *   because it does not inspect credentials outside the gateway contract. Model
 *   selection is disabled because eve cannot rewrite the authored source.
 * - `gateway` + `connected: true`: routed through the Vercel AI Gateway with a
 *   resolvable credential (`api-key` from `AI_GATEWAY_API_KEY`, else `oidc`).
 * - `gateway` + `connected: false`: routed through the gateway with neither a
 *   gateway API key nor an OIDC token. This is the "no provider connected" state
 *   that gates the "provider required" setup prompt.
 */
export type ModelEndpointStatus = z.infer<typeof modelEndpointStatusSchema>;

// Strip-mode on purpose: this schema is parsed by clients (`eve/client`, the
// dev TUI) against servers that may be newer and carry fields this build does
// not know. Unknown keys are dropped instead of failing the parse.
export const modelEndpointStatusSchema = z.union([
  z.object({
    kind: z.literal("codex"),
    connected: z.literal(true),
    credential: z.enum(["api-key", "chatgpt"]),
  }),
  z.object({
    kind: z.literal("codex"),
    connected: z.literal(false),
    reason: z.enum(["missing", "invalid", "refresh-token-missing"]),
  }),
  z.object({ kind: z.literal("external"), provider: z.string() }),
  z.object({
    kind: z.literal("gateway"),
    connected: z.literal(true),
    credential: z.enum(["api-key", "oidc"]),
  }),
  z.object({ kind: z.literal("gateway"), connected: z.literal(false) }),
]);
