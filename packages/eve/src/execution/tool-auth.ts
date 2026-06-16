/**
 * Tool-hosted authorization wiring for authored tools that declare
 * `auth` on {@link defineTool}.
 *
 * Mirrors the connection authorization flow (see
 * `runtime/framework-tools/connection-search-dynamic.ts`) but scopes the
 * per-step token cache and framework-owned callback URL by the tool's
 * path-derived name instead of a connection name. All the shared
 * machinery — principal resolution, cache reads/writes, the park/resume
 * webhook dance, and the loop guard — lives in
 * `runtime/connections/scoped-authorization.ts`; this module is the thin
 * execution-layer adapter that wraps one tool's `execute`.
 */

import { buildCallbackContext } from "#context/build-callback-context.js";
import {
  ConnectionAuthorizationFailedError,
  ConnectionAuthorizationRequiredError,
  isConnectionAuthorizationRequiredError,
} from "#public/connections/errors.js";
import type { ToolContext } from "#public/definitions/tool.js";
import {
  type AuthorizationDefinition,
  supportsInteractiveAuthorization,
  type TokenResult,
} from "#runtime/connections/types.js";
import {
  completeScopedAuthorization,
  evictScopedToken,
  resolveScopedToken,
  startScopedAuthorization,
  type ScopedAuthorization,
} from "#runtime/connections/scoped-authorization.js";

/**
 * Wraps one authored tool's `execute` with the tool-hosted
 * authorization flow.
 *
 * Each invocation:
 * 1. Completes an authorization whose OAuth callback arrived this turn,
 *    caching the freshly minted token (the loop-guard flag).
 * 2. Runs the authored `execute` with a {@link ToolContext} whose
 *    `getToken()` / `requireAuth()` are bound to this tool's scope.
 * 3. On a thrown `ConnectionAuthorizationRequiredError` — implicit from
 *    `getToken()` or explicit via `requireAuth()` — either fails
 *    terminally (token rejected immediately after sign-in) or evicts the
 *    rejected token from the per-step cache and starts the interactive
 *    flow, returning an `AuthorizationSignal` to park the turn. An
 *    interactive strategy never rethrows the raw `Required` into the
 *    model: if no callback URL can be minted it fails with a classified
 *    {@link ConnectionAuthorizationFailedError} instead. Only
 *    non-interactive strategies rethrow the original error, since they
 *    have no consent flow to park on.
 */
export function createAuthorizedToolExecute(input: {
  readonly scope: string;
  readonly auth: AuthorizationDefinition;
  readonly execute: (toolInput: unknown, ctx: unknown) => unknown;
}): (toolInput: unknown) => Promise<unknown> {
  const { scope, auth, execute } = input;
  const scoped: ScopedAuthorization = {
    authorization: auth,
    connection: { url: "" },
    scope,
  };

  return async (toolInput: unknown): Promise<unknown> => {
    const justAuthorized = await completeScopedAuthorization(scoped);

    try {
      return await execute(toolInput, buildToolContext(scoped));
    } catch (err) {
      if (!isConnectionAuthorizationRequiredError(err)) throw err;

      // Loop guard: a token minted this turn that is still rejected
      // means the grant itself is broken — fail terminally instead of
      // re-prompting into an infinite sign-in loop.
      if (justAuthorized) {
        throw new ConnectionAuthorizationFailedError(scope, {
          message: `Tool "${scope}" rejected the token immediately after authorization.`,
          reason: "token_rejected_after_authorization",
          retryable: false,
        });
      }

      // The resolved bearer was rejected (a downstream 401 mapped to
      // requireAuth, or getToken re-reporting Required). Drop it from
      // every cache layer — eve's per-step cache and the strategy's own
      // (e.g. the @vercel/connect token cache) — so the
      // re-authorization re-resolves a genuinely fresh token instead of
      // re-reading the rejected one. Mirrors the MCP client.
      await evictScopedToken(scoped);

      const signal = await startScopedAuthorization(scoped);
      if (signal !== undefined) return signal;

      // No park signal. For an interactive strategy this means the
      // framework could not mint a callback URL (no session id / base
      // URL in context). Never let the raw `Required` reach the model —
      // it improvises by surfacing the auth URL as text and loops
      // (see research/per-tool-auth-known-issues.md, issue 2). Fail with
      // a classified, terminal authorization error instead. Non-interactive
      // strategies have no consent flow, so their original error is the
      // right thing for the model to see.
      if (supportsInteractiveAuthorization(auth)) {
        throw new ConnectionAuthorizationFailedError(scope, {
          message:
            `Tool "${scope}" requires sign-in, but no authorization callback URL ` +
            `could be minted for this run (missing session context).`,
          reason: "authorization_callback_unavailable",
          retryable: false,
        });
      }

      throw err;
    }
  };
}

/**
 * Builds the {@link ToolContext} for an authored tool that does **not**
 * declare `auth`. The token accessors are present (the type promises
 * them) but throw, since there is no strategy to resolve a token from.
 */
export function buildUnauthorizedToolContext(scope: string): ToolContext {
  const base = buildCallbackContext();
  return {
    ...base,
    getToken(): Promise<TokenResult> {
      throw noAuthError(scope);
    },
    requireAuth(): never {
      throw noAuthError(scope);
    },
  };
}

/**
 * Builds the {@link ToolContext} handed to an authorized tool's
 * `execute`: the base session context plus token accessors bound to the
 * tool's scope.
 */
function buildToolContext(scoped: ScopedAuthorization): ToolContext {
  const base = buildCallbackContext();
  return {
    ...base,
    getToken(): Promise<TokenResult> {
      return resolveScopedToken(scoped);
    },
    requireAuth(): never {
      throw new ConnectionAuthorizationRequiredError(scoped.scope);
    },
  };
}

function noAuthError(scope: string): Error {
  return new Error(
    `Tool "${scope}" called ctx.getToken()/ctx.requireAuth() but does not declare an "auth" strategy. ` +
      `Add \`auth\` to the tool definition (e.g. \`connect("...")\` from "@vercel/connect/eve").`,
  );
}
