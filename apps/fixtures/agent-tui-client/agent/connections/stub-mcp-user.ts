import { createHash, randomBytes } from "node:crypto";

import {
  ConnectionAuthorizationFailedError,
  ConnectionAuthorizationRequiredError,
  defineInteractiveAuthorization,
  defineMcpClientConnection,
  type McpClientConnectionDefinition,
} from "eve/connections";

/**
 * Smoke-test fixture: a user-principal MCP client connection that
 * drives a real OAuth 2.1 + PKCE flow against an external IdP. Used
 * by `packages/eve/test/tui-client/tui-connection-auth-user.ts` to prove the
 * `authorization.*` lifecycle end-to-end through the live
 * runtime, with an actual token exchange.
 *
 * This file covers the realistic 90%+ case: real MCP connections use
 * user principal and interactive OAuth.
 *
 * It carries the PKCE `verifier` in `resume`, which the framework
 * serializes across workflow steps to survive the park.
 *
 * Three env vars gate participation:
 *
 *  - `EVE_TEST_MCP_STUB_USER_AUTH` must be `"1"`. Without it the
 *    connection is inert (`auth` is omitted), so other smokes
 *    booting agent-tui-client see no extra behavior. The stub MCP URL
 *    still falls back to a sentinel that fails fast on first use.
 *  - `EVE_TEST_MCP_STUB_URL` points at the in-process stub MCP
 *    server the smoke starts up.
 *  - `EVE_TEST_OAUTH_EMULATOR_URL` points at the
 *    `@emulators/microsoft` OAuth provider emulator the smoke spins
 *    up. Required when `EVE_TEST_MCP_STUB_USER_AUTH=1`; checked
 *    lazily inside `startAuthorization` so a misconfigured smoke
 *    fails with a clear message rather than at agent boot.
 */
const url = process.env.EVE_TEST_MCP_STUB_URL ?? "http://127.0.0.1:0/mcp";
const userAuthEnabled = process.env.EVE_TEST_MCP_STUB_USER_AUTH === "1";

const CLIENT_ID = "eve-smoke-client";
const CLIENT_SECRET = "eve-smoke-secret";

type OAuthState = {
  readonly [key: string]: string;
  readonly verifier: string;
  readonly state: string;
};

/**
 * Module-level cache of `code → access_token`. The framework runtime
 * may call `completeAuthorization` more than once per auth cycle
 * (observed: a replay after the successful first exchange). The
 * second exchange would 400 because the IdP one-shots authorization
 * codes, so cache the result by `code` and short-circuit. OAuth
 * codes are unique-per-flow, so the cache key is naturally scoped.
 */
const exchangedTokens = new Map<string, string>();
const pendingTokenExchanges = new Map<string, Promise<string>>();

/**
 * Module-level cache of `principalId → access_token`. The runtime's
 * built-in cache is per-step (see
 * `packages/eve/src/runtime/connections/authorization-tokens.ts:7-9`),
 * so cross-step reuse is the connection author's responsibility, in
 * production via a refresh-token grant or upstream provider cache. For
 * the smoke we just hold the token in memory keyed by the resolved
 * principal id, which lets `getToken` return the token on subsequent
 * tool calls in the same session without re-running the OAuth flow.
 */
const principalTokens = new Map<string, string>();

const definition: McpClientConnectionDefinition = {
  url,
  description:
    "Smoke-test stub MCP behind a real OAuth 2.1 + PKCE flow against the @emulators/microsoft IdP. Exposes the same echo_marker tool as stub-mcp.",
};

if (userAuthEnabled) {
  definition.auth = defineInteractiveAuthorization<OAuthState>({
    async getToken({ principal }) {
      // `defineInteractiveAuthorization` pins `principalType: "user"`,
      // so the runtime always passes a user-principal here. The
      // discriminator narrows `id` into existence.
      if (principal.type === "user") {
        const cached = principalTokens.get(principal.id);
        if (cached !== undefined) {
          return { token: cached };
        }
      }
      throw new ConnectionAuthorizationRequiredError("stub-mcp-user");
    },
    async startAuthorization({ callbackUrl }) {
      const oauthBase = process.env.EVE_TEST_OAUTH_EMULATOR_URL;
      if (oauthBase === undefined || oauthBase.length === 0) {
        throw new Error(
          "stub-mcp-user: EVE_TEST_OAUTH_EMULATOR_URL must be set when EVE_TEST_MCP_STUB_USER_AUTH=1",
        );
      }
      const verifier = randomBytes(32).toString("base64url");
      const challenge = createHash("sha256").update(verifier).digest("base64url");
      const state = randomBytes(16).toString("base64url");
      const authorizeUrl = new URL(`${oauthBase}/oauth2/v2.0/authorize`);
      authorizeUrl.searchParams.set("client_id", CLIENT_ID);
      authorizeUrl.searchParams.set("redirect_uri", callbackUrl);
      authorizeUrl.searchParams.set("response_type", "code");
      authorizeUrl.searchParams.set("scope", "openid profile email");
      authorizeUrl.searchParams.set("state", state);
      authorizeUrl.searchParams.set("code_challenge", challenge);
      authorizeUrl.searchParams.set("code_challenge_method", "S256");
      return {
        challenge: {
          url: authorizeUrl.toString(),
          instructions: "Authorize the smoke-test stub app on the emulator.",
        },
        resume: { verifier, state },
      };
    },
    async completeAuthorization({ principal, resume, callbackUrl, callback }) {
      if (resume === undefined) {
        throw new Error("stub-mcp-user: missing authorization resume state");
      }
      const code = callback.params.code;
      const returnedState = callback.params.state;
      if (returnedState !== resume.state) {
        throw new ConnectionAuthorizationFailedError("stub-mcp-user", {
          reason: "state_mismatch",
          retryable: false,
        });
      }
      if (code === undefined || code.length === 0) {
        throw new ConnectionAuthorizationFailedError("stub-mcp-user", {
          reason: "missing_code",
          retryable: false,
        });
      }
      const cached = exchangedTokens.get(code);
      if (cached !== undefined) {
        return { token: cached };
      }
      const pending =
        pendingTokenExchanges.get(code) ??
        exchangeAuthorizationCode({
          callbackUrl,
          code,
          verifier: resume.verifier,
        });
      pendingTokenExchanges.set(code, pending);
      try {
        const token = await pending;
        exchangedTokens.set(code, token);
        if (principal.type === "user") {
          principalTokens.set(principal.id, token);
        }
        return { token };
      } finally {
        pendingTokenExchanges.delete(code);
      }
    },
  });
}

export default defineMcpClientConnection(definition);

async function exchangeAuthorizationCode(input: {
  readonly callbackUrl: string;
  readonly code: string;
  readonly verifier: string;
}): Promise<string> {
  const oauthBase = process.env.EVE_TEST_OAUTH_EMULATOR_URL;
  if (oauthBase === undefined || oauthBase.length === 0) {
    throw new Error(
      "stub-mcp-user: EVE_TEST_OAUTH_EMULATOR_URL must be set when EVE_TEST_MCP_STUB_USER_AUTH=1",
    );
  }
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: input.code,
    code_verifier: input.verifier,
    redirect_uri: input.callbackUrl,
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
  });
  const tokenResponse = await fetch(`${oauthBase}/oauth2/v2.0/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!tokenResponse.ok) {
    throw new ConnectionAuthorizationFailedError("stub-mcp-user", {
      reason: "token_exchange_failed",
      message: `Token endpoint returned ${tokenResponse.status}: ${await tokenResponse.text()}`,
      retryable: false,
    });
  }
  const json = (await tokenResponse.json()) as { access_token?: unknown };
  if (typeof json.access_token !== "string" || json.access_token.length === 0) {
    throw new ConnectionAuthorizationFailedError("stub-mcp-user", {
      reason: "missing_access_token",
      retryable: false,
    });
  }
  return json.access_token;
}
