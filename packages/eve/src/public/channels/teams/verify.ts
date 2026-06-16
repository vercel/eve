/**
 * Microsoft Teams inbound Bot Framework request verification.
 *
 * Teams sends bot activities through the Bot Connector service. eve verifies
 * the bearer JWT against Bot Connector OpenID keys and the bot's Microsoft
 * app id before dispatching any activity to the runtime.
 */

import type { JWTPayload } from "#compiled/jose/index.js";
import { importJWK, jwtVerify } from "#compiled/jose/index.js";

import { createLogger } from "#internal/logging.js";
import { resolveTeamsAppId, type TeamsAppId, type TeamsFetch } from "#public/channels/teams/api.js";
import { isObject } from "#shared/guards.js";

const log = createLogger("teams.verify");

const DEFAULT_BOT_CONNECTOR_OPENID_METADATA_URL =
  "https://login.botframework.com/v1/.well-known/openidconfiguration";
const BOT_CONNECTOR_ISSUER = "https://api.botframework.com";

/**
 * Caller-supplied inbound webhook verifier. Replaces Bot Connector JWT
 * verification when a trusted integration authenticates forwarded requests
 * before they reach eve.
 *
 * Return a falsy value to reject the request (verification throws), a string
 * to accept and use that string as the verified body, or any other truthy
 * value to accept and keep the original request body.
 */
export type TeamsWebhookVerifier = (request: Request, body: string) => unknown | Promise<unknown>;

/** Options for {@link verifyTeamsRequest}. */
export interface TeamsVerifyOptions {
  readonly appId?: TeamsAppId;
  readonly fetch?: TeamsFetch;
  readonly jwksUrl?: string;
  /** Max allowed clock skew, in seconds. Defaults to 5 minutes. */
  readonly maxSkewSeconds?: number;
  readonly openIdMetadataUrl?: string;
  readonly webhookVerifier?: TeamsWebhookVerifier;
}

/** Options for {@link verifyTeamsJwt}. */
export interface TeamsJwtVerifyOptions {
  readonly appId?: TeamsAppId;
  readonly fetch?: TeamsFetch;
  readonly jwksUrl?: string;
  /** Max allowed clock skew, in seconds. Defaults to 5 minutes. */
  readonly maxSkewSeconds?: number;
  readonly openIdMetadataUrl?: string;
}

/**
 * Verifies an inbound Teams request and returns the raw body.
 *
 * Uses `webhookVerifier` when provided, otherwise validates the bearer JWT
 * against Bot Connector keys and the resolved app id. Throws when the
 * verifier rejects the request, the bearer token is missing, no app id can be
 * resolved (`appId` option or `MICROSOFT_APP_ID`/`TEAMS_APP_ID`), metadata or
 * keys cannot be loaded, or JWT verification fails.
 */
export async function verifyTeamsRequest(
  request: Request,
  options: TeamsVerifyOptions,
): Promise<string> {
  const body = await request.text();

  if (options.webhookVerifier !== undefined) {
    const result = await options.webhookVerifier(request, body);
    if (!result) {
      throw new Error("teamsChannel: inbound webhook verifier rejected the request.");
    }
    return typeof result === "string" ? result : body;
  }

  const authorization = request.headers.get("authorization") ?? "";
  const token = readBearerToken(authorization);
  if (!token) {
    throw new Error("teamsChannel: inbound request missing bearer token.");
  }

  await verifyTeamsJwt(token, options);
  return body;
}

/** Verifies one Bot Connector JWT and returns its payload. */
export async function verifyTeamsJwt(
  token: string,
  options: TeamsJwtVerifyOptions,
): Promise<JWTPayload> {
  const appId = await resolveTeamsAppId(options.appId);
  const jwks = await loadJwks(options);

  const result = await jwtVerify(
    token,
    async (protectedHeader) => {
      const key = selectJwk(jwks, protectedHeader);
      const alg = typeof protectedHeader.alg === "string" ? protectedHeader.alg : undefined;
      return importJWK(key, alg);
    },
    {
      audience: appId,
      clockTolerance: options.maxSkewSeconds ?? 60 * 5,
      issuer: BOT_CONNECTOR_ISSUER,
    },
  );

  return result.payload;
}

function readBearerToken(authorization: string): string | null {
  const [scheme, token] = authorization.split(/\s+/, 2);
  if (scheme?.toLowerCase() !== "bearer" || !token) return null;
  return token;
}

async function loadJwks(
  options: TeamsJwtVerifyOptions,
): Promise<readonly Record<string, unknown>[]> {
  const apiFetch = options.fetch ?? fetch;
  const jwksUrl = options.jwksUrl ?? (await loadJwksUrl(options, apiFetch));
  const response = await apiFetch(jwksUrl, { headers: { accept: "application/json" } });
  if (!response.ok) {
    throw new Error(`Teams JWKS route returned HTTP ${response.status}.`);
  }
  const body = (await response.json()) as unknown;
  if (!isObject(body) || !Array.isArray(body.keys)) {
    throw new Error("Teams JWKS response is malformed.");
  }
  return body.keys.filter(isObject);
}

async function loadJwksUrl(options: TeamsJwtVerifyOptions, apiFetch: TeamsFetch): Promise<string> {
  const metadataUrl = options.openIdMetadataUrl ?? DEFAULT_BOT_CONNECTOR_OPENID_METADATA_URL;
  const response = await apiFetch(metadataUrl, { headers: { accept: "application/json" } });
  if (!response.ok) {
    throw new Error(`Teams OpenID metadata route returned HTTP ${response.status}.`);
  }
  const body = (await response.json()) as unknown;
  if (!isObject(body) || typeof body.jwks_uri !== "string") {
    throw new Error("Teams OpenID metadata response is missing jwks_uri.");
  }
  return body.jwks_uri;
}

function selectJwk(
  keys: readonly Record<string, unknown>[],
  header: Record<string, unknown>,
): Record<string, unknown> {
  const kid = typeof header.kid === "string" ? header.kid : undefined;
  const x5t = typeof header.x5t === "string" ? header.x5t : undefined;

  const selected =
    keys.find(
      (key) => (kid !== undefined && key.kid === kid) || (x5t !== undefined && key.x5t === x5t),
    ) ?? (keys.length === 1 ? keys[0] : undefined);
  if (selected === undefined) {
    log.debug("Teams JWT key not found", { kid, x5t });
    throw new Error("teamsChannel: inbound JWT key was not found in JWKS.");
  }
  return selected;
}
