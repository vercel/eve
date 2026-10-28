import type { TeamsAppId } from "#public/channels/teams/api.js";
import type { TeamsAppPassword } from "#public/channels/teams/api.js";
import type { TeamsTenantId } from "#public/channels/teams/api.js";
import type { TeamsTokenProvider } from "#public/channels/teams/api.js";
import type { TeamsWebhookVerifier } from "#public/channels/teams/verify.js";

/** Credentials for the Teams channel and its API. */
export interface TeamsChannelCredentials {
  readonly appId?: TeamsAppId;
  readonly appPassword?: TeamsAppPassword;
  readonly tenantId?: TeamsTenantId;
  readonly tokenProvider?: TeamsTokenProvider;
  readonly webhookVerifier?: TeamsWebhookVerifier;
}
