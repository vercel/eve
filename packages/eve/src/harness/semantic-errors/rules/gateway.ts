import { allOf, anyOf, messageMatches, nameIs, typeIs, type SemanticErrorRule } from "../rule.js";

/** The summary `name` shared by the gateway-auth rule variants. */
const GATEWAY_AUTH_FAILURE_SUMMARY_NAME = "AI Gateway authentication failed";

/**
 * The upstream `GatewayAuthenticationError` builds one of exactly three
 * contextual messages depending on which credential was offered — verbatim
 * in the vendored `@ai-sdk/gateway` source: "AI Gateway authentication
 * failed: Invalid API key." / ": Invalid OIDC token." / ": No
 * authentication provided.". Each variant gets its own rule so the
 * remediation matches the credential that actually failed — collapsing all
 * three into a single "set AI_GATEWAY_API_KEY" hint misleads users whose
 * shell already exports a stale `AI_GATEWAY_API_KEY` that shadows the OIDC
 * fallback.
 */
const gatewayAuthenticationFailure = anyOf(
  nameIs("GatewayAuthenticationError"),
  typeIs("authentication_error"),
  messageMatches(/AI Gateway authentication/i),
);

/**
 * Error class names and body `type` discriminators are verified against
 * the vendored `@ai-sdk/gateway` source: the `Gateway*Error` classes and
 * the body types `authentication_error`, `invalid_request_error`,
 * `model_not_found`, `rate_limit_exceeded`, `timeout_error`,
 * `internal_server_error` all appear there verbatim. `overloaded_error`
 * is not gateway vocabulary — it is the Anthropic upstream error type the
 * gateway relays on provider overload.
 */
export const GATEWAY_RULES: readonly SemanticErrorRule[] = [
  {
    id: "gateway-auth-invalid-api-key",
    name: GATEWAY_AUTH_FAILURE_SUMMARY_NAME,
    tags: ["gateway", "config"],
    when: allOf(gatewayAuthenticationFailure, messageMatches(/Invalid API key/i)),
    message: "AI Gateway rejected the provided API key.",
    hint: "Update or unset `AI_GATEWAY_API_KEY` (check your shell profile if you did not set it for this project) — manage keys at https://vercel.com/dashboard/ai/api-keys. Unsetting it falls back to OIDC via `eve link`.",
  },
  {
    id: "gateway-auth-invalid-oidc-token",
    name: GATEWAY_AUTH_FAILURE_SUMMARY_NAME,
    tags: ["gateway", "config"],
    when: allOf(gatewayAuthenticationFailure, messageMatches(/Invalid OIDC token/i)),
    message: "AI Gateway rejected the OIDC token.",
    hint: "Run `eve link` to refresh `VERCEL_OIDC_TOKEN` in `.env.local`, or set `AI_GATEWAY_API_KEY` — create a key at https://vercel.com/dashboard/ai/api-keys.",
  },
  {
    id: "gateway-auth-missing-credentials",
    name: GATEWAY_AUTH_FAILURE_SUMMARY_NAME,
    tags: ["gateway", "config"],
    when: gatewayAuthenticationFailure,
    message: "AI Gateway received no credentials.",
    hint: "Run `eve link` to populate `VERCEL_OIDC_TOKEN`, or set `AI_GATEWAY_API_KEY` — create a key at https://vercel.com/dashboard/ai/api-keys.",
  },
  {
    id: "model-not-found",
    name: "Model not found",
    tags: ["gateway", "config"],
    when: anyOf(
      nameIs("GatewayModelNotFoundError", "AI_NoSuchModelError"),
      typeIs("model_not_found"),
    ),
    message: "The requested model is not available.",
    hint: "Check the model id in `agent.ts` (`model:`) or switch models with `/model` in `eve dev` — browse available models at https://vercel.com/ai-gateway/models.",
  },
  {
    id: "gateway-rate-limited",
    name: "AI Gateway rate limit exceeded",
    tags: ["gateway", "transient"],
    when: anyOf(nameIs("GatewayRateLimitError"), typeIs("rate_limit_exceeded")),
    message: "AI Gateway rate-limited the request.",
    hint: "Retries are automatic; if it persists, reduce request volume or review your plan limits at https://vercel.com/ai-gateway.",
  },
  {
    id: "gateway-upstream-unavailable",
    name: "Model provider unavailable",
    tags: ["gateway", "transient"],
    when: anyOf(nameIs("GatewayTimeoutError"), typeIs("timeout_error", "overloaded_error")),
    message: "The model provider is overloaded or timing out upstream of AI Gateway.",
    hint: "This is transient — retry shortly, or switch models with `/model` in `eve dev`.",
  },
];
