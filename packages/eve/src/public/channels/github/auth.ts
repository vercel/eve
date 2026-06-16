import { createSign } from "node:crypto";

import { isObject } from "#shared/guards.js";
import type { GitHubWebhookVerifier } from "#public/channels/github/verify.js";

/** GitHub App id, supplied directly or resolved lazily from a secret manager. */
export type GitHubAppId = number | string | (() => number | string | Promise<number | string>);

/** GitHub App private key, supplied directly or resolved lazily from a secret manager. */
export type GitHubPrivateKey = string | (() => string | Promise<string>);

/** GitHub webhook secret, supplied directly or resolved lazily from a secret manager. */
export type GitHubWebhookSecret = string | (() => string | Promise<string>);

/**
 * Pre-resolved GitHub installation access token, supplied directly or
 * resolved lazily from a secret manager. When present, eve skips the native
 * `appId`/`privateKey`/`installationId` JWT-minting path. Integrations such
 * as Connect derive the installation token out-of-band and set this field.
 */
export type GitHubInstallationToken = string | (() => string | Promise<string>);

/** Credentials used by the native GitHub channel. */
export interface GitHubChannelCredentials {
  readonly appId?: GitHubAppId;
  readonly privateKey?: GitHubPrivateKey;
  readonly webhookSecret?: GitHubWebhookSecret;
  /**
   * Pre-resolved GitHub installation access token. When supplied, eve uses
   * it directly for authenticated GitHub API calls and skips the native
   * `appId`/`privateKey` JWT exchange; `installationId` is not required.
   * Integrations such as Connect derive the token out-of-band and set this
   * field.
   */
  readonly installationToken?: GitHubInstallationToken;
  /**
   * Custom inbound webhook verifier. When supplied, eve skips the
   * `GITHUB_WEBHOOK_SECRET` fallback and delegates verification to this
   * function. Integrations such as Connect authenticate webhooks
   * out-of-band and set this field.
   */
  readonly webhookVerifier?: GitHubWebhookVerifier;
}

/** Options needed by GitHub App auth helpers. */
export interface GitHubAuthApiOptions {
  readonly apiBaseUrl?: string;
  readonly fetch?: typeof fetch;
}

interface CachedInstallationToken {
  readonly expiresAtMs: number;
  readonly token: string;
}

const installationTokenCache = new Map<string, CachedInstallationToken>();
const TOKEN_REFRESH_SKEW_MS = 60_000;

/** Resolves a GitHub App id, falling back to `GITHUB_APP_ID`. */
export async function resolveGitHubAppId(appId?: GitHubAppId): Promise<string> {
  const source = appId ?? process.env.GITHUB_APP_ID;
  if (source === undefined || source === "") {
    throw new Error("githubChannel: GITHUB_APP_ID is required.");
  }
  const value = typeof source === "function" ? await source() : source;
  return String(value);
}

/** Resolves and normalizes a GitHub App private key. */
export async function resolveGitHubPrivateKey(privateKey?: GitHubPrivateKey): Promise<string> {
  const source = privateKey ?? process.env.GITHUB_APP_PRIVATE_KEY;
  if (!source) {
    throw new Error("githubChannel: GITHUB_APP_PRIVATE_KEY is required.");
  }
  const value = typeof source === "function" ? await source() : source;
  return normalizeGitHubPrivateKey(value);
}

/** Resolves a GitHub webhook secret, falling back to `GITHUB_WEBHOOK_SECRET`. */
export async function resolveGitHubWebhookSecret(
  webhookSecret?: GitHubWebhookSecret,
): Promise<string> {
  const source = webhookSecret ?? process.env.GITHUB_WEBHOOK_SECRET;
  if (!source) {
    throw new Error("githubChannel: GITHUB_WEBHOOK_SECRET is required.");
  }
  return typeof source === "function" ? await source() : source;
}

/** Converts hosted-platform escaped newlines back into PEM newlines. */
export function normalizeGitHubPrivateKey(privateKey: string): string {
  return privateKey.replace(/\\n/gu, "\n");
}

/** Creates a short-lived RS256 GitHub App JWT. */
export async function createGitHubAppJwt(input: {
  readonly appId?: GitHubAppId;
  readonly now?: Date;
  readonly privateKey?: GitHubPrivateKey;
}): Promise<string> {
  const appId = await resolveGitHubAppId(input.appId);
  const privateKey = await resolveGitHubPrivateKey(input.privateKey);
  const nowSeconds = Math.floor((input.now?.getTime() ?? Date.now()) / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const payload = {
    exp: nowSeconds + 10 * 60,
    iat: nowSeconds - 60,
    iss: appId,
  };
  const signingInput = `${base64UrlJson(header)}.${base64UrlJson(payload)}`;
  const signature = createSign("RSA-SHA256").update(signingInput).sign(privateKey, "base64url");
  return `${signingInput}.${signature}`;
}

/**
 * Resolves an installation access token by minting and caching a GitHub App
 * installation token in process memory.
 */
export async function resolveGitHubInstallationToken(input: {
  readonly api?: GitHubAuthApiOptions;
  readonly credentials?: GitHubChannelCredentials;
  readonly installationId: number | undefined;
}): Promise<string> {
  const installationToken = input.credentials?.installationToken;
  if (installationToken !== undefined) {
    return typeof installationToken === "function" ? await installationToken() : installationToken;
  }

  if (input.installationId === undefined) {
    throw new Error(
      "githubChannel: installationId is required for authenticated GitHub API calls.",
    );
  }

  return createGitHubInstallationToken({
    api: input.api,
    appId: input.credentials?.appId,
    installationId: input.installationId,
    privateKey: input.credentials?.privateKey,
  });
}

/**
 * Exchanges a GitHub App JWT for an installation access token, cached until
 * shortly before GitHub's reported expiry.
 */
export async function createGitHubInstallationToken(input: {
  readonly api?: GitHubAuthApiOptions;
  readonly appId?: GitHubAppId;
  readonly installationId: number;
  readonly privateKey?: GitHubPrivateKey;
}): Promise<string> {
  const appId = await resolveGitHubAppId(input.appId);
  const apiBaseUrl = input.api?.apiBaseUrl ?? "https://api.github.com";
  const cacheKey = `${apiBaseUrl}:${appId}:${input.installationId}`;
  const cached = installationTokenCache.get(cacheKey);
  if (cached !== undefined && Date.now() < cached.expiresAtMs - TOKEN_REFRESH_SKEW_MS) {
    return cached.token;
  }

  const jwt = await createGitHubAppJwt({
    appId,
    privateKey: input.privateKey,
  });
  const apiFetch = input.api?.fetch ?? fetch;
  const response = await apiFetch(
    `${apiBaseUrl}/app/installations/${input.installationId}/access_tokens`,
    {
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${jwt}`,
        "x-github-api-version": "2022-11-28",
      },
      method: "POST",
    },
  );
  const body = await parseJsonBody(response);
  if (!response.ok) {
    throw new Error(
      `githubChannel: create installation token failed with HTTP ${response.status}.`,
    );
  }
  if (!isObject(body) || typeof body.token !== "string") {
    throw new Error("githubChannel: installation token response did not include a token.");
  }

  const expiresAtMs = parseExpiryMs(body.expires_at);
  installationTokenCache.set(cacheKey, { expiresAtMs, token: body.token });
  return body.token;
}

/** Clears the in-memory GitHub installation token cache. Intended for tests. */
export function clearGitHubInstallationTokenCache(): void {
  installationTokenCache.clear();
}

/** Seeds the in-memory installation token cache. Intended for tests. */
export function seedGitHubInstallationTokenForTests(input: {
  readonly apiBaseUrl?: string;
  readonly appId?: string;
  readonly installationId: number;
  readonly token: string;
}): void {
  const apiBaseUrl = input.apiBaseUrl ?? "https://api.github.com";
  const appId = input.appId ?? "test-app";
  installationTokenCache.set(`${apiBaseUrl}:${appId}:${input.installationId}`, {
    expiresAtMs: Date.now() + 60 * 60 * 1000,
    token: input.token,
  });
}

function base64UrlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

async function parseJsonBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function parseExpiryMs(value: unknown): number {
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return Date.now() + 60 * 60 * 1000;
}
