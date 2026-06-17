/**
 * How the agent reaches its model and whether it's ready: the build-time
 * {@link ModelRouting} composed with runtime credential presence. A client (the
 * dev TUI status bar, or any other consumer of `/eve/v1/info`) shows and gates
 * on three states:
 *
 * - `external`: a direct provider endpoint, not the gateway. eve makes no
 *   connectedness claim, since the provider key lives in the agent's own code
 *   rather than the gateway's credentials, and model selection is disabled
 *   because eve cannot rewrite the authored source.
 * - `gateway` + `connected: true`: routed through the Vercel AI Gateway with a
 *   resolvable credential (`api-key` from `AI_GATEWAY_API_KEY`, else `oidc`).
 * - `gateway` + `connected: false`: routed through the gateway with neither a
 *   gateway API key nor an OIDC token. This is the "no provider connected" state
 *   that gates the "provider required" setup prompt.
 */
export type ModelEndpointStatus =
  | { kind: "external"; provider: string }
  | { kind: "gateway"; connected: true; credential: "api-key" | "oidc" }
  | { kind: "gateway"; connected: false };
