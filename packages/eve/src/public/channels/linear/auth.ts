/**
 * Linear channel credential resolvers.
 *
 * eve keeps Linear access tokens out of model-visible context. Channel helpers
 * resolve them only when verifying inbound webhooks or calling Linear's
 * GraphQL API to emit Agent Activities.
 */

export type LinearAccessToken = string | (() => string | Promise<string>);
export type LinearWebhookSecret = string | (() => string | Promise<string>);

export interface LinearChannelCredentials {
  /**
   * OAuth app-token or API key used for Linear GraphQL calls. For the Agent
   * surface this should usually be an OAuth token installed with `actor=app`.
   */
  readonly accessToken?: LinearAccessToken;
  /** Signing secret from the Linear webhook configuration. */
  readonly webhookSecret?: LinearWebhookSecret;
  /** Optional custom verifier for trusted webhook forwarders. */
  readonly webhookVerifier?: import("#public/channels/linear/verify.js").LinearWebhookVerifier;
}

export async function resolveLinearAccessToken(
  token: LinearAccessToken | undefined,
): Promise<string> {
  const resolved =
    typeof token === "function"
      ? await token()
      : (token ??
        process.env.LINEAR_AGENT_ACCESS_TOKEN ??
        process.env.LINEAR_ACCESS_TOKEN ??
        process.env.LINEAR_API_KEY ??
        process.env.LINEAR_API_TOKEN);

  if (!resolved) {
    throw new Error(
      "linearChannel: missing Linear access token. Pass credentials.accessToken or set " +
        "LINEAR_AGENT_ACCESS_TOKEN, LINEAR_ACCESS_TOKEN, LINEAR_API_KEY, or LINEAR_API_TOKEN.",
    );
  }

  return resolved;
}

export async function resolveLinearWebhookSecret(
  secret: LinearWebhookSecret | undefined,
): Promise<string> {
  const resolved =
    typeof secret === "function" ? await secret() : (secret ?? process.env.LINEAR_WEBHOOK_SECRET);

  if (!resolved) {
    throw new Error(
      "linearChannel: missing webhook secret. Pass credentials.webhookSecret, set " +
        "LINEAR_WEBHOOK_SECRET, or supply credentials.webhookVerifier.",
    );
  }

  return resolved;
}
