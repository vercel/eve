/**
 * How the agent reaches its model and whether it's ready: the build-time model
 * auth/routing facts composed with runtime credential presence. A client (the
 * dev TUI status bar, or any other consumer of `/eve/v1/info`) shows and gates
 * on these states:
 *
 * - `codex`: authenticated through a Codex model adapter. eve does not inspect
 *   provider credentials; the model call remains the readiness source of truth.
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
export type ModelEndpointStatus =
  | { kind: "codex" }
  | { kind: "external"; provider: string }
  | { kind: "gateway"; connected: true; credential: "api-key" | "oidc" }
  | { kind: "gateway"; connected: false };
