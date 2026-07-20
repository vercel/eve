/**
 * Tool-hosted authorization wiring for authored tools that resolve auth
 * providers inline with {@link ToolContext.getToken} and
 * {@link ToolContext.requireAuth}.
 *
 * Mirrors the connection authorization flow (see
 * `runtime/framework-tools/connection-search-dynamic.ts`) but scopes the
 * per-step token cache and framework-owned callback URL by the tool's
 * path-derived name and provider key instead of a connection name. All the shared
 * machinery — principal resolution, cache reads/writes, the park/resume
 * webhook dance, and the loop guard — lives in
 * `runtime/connections/scoped-authorization.ts`; this module is the thin
 * execution-layer adapter that wraps one tool's `execute`.
 */

import { buildBaseToolContext } from "#context/build-base-tool-context.js";
import {
  ConnectionAuthorizationFailedError,
  ConnectionAuthorizationRequiredError,
  isConnectionAuthorizationRequiredError,
} from "#public/connections/errors.js";
import type { ToolAuthOptions, ToolAuthProvider, ToolContext } from "#public/definitions/tool.js";
import { type AuthorizationChallenge, requestAuthorization } from "#harness/authorization.js";
import {
  type AuthorizationDefinition,
  supportsInteractiveAuthorization,
  type TokenResult,
} from "#runtime/connections/types.js";
import { normalizeAuthorizationSpec } from "#runtime/connections/validate-authorization.js";
import {
  completeScopedAuthorization,
  evictScopedToken,
  resolveScopedToken,
  startScopedAuthorization,
  type ScopedAuthorization,
} from "#runtime/connections/scoped-authorization.js";
import type { ToolExecuteOptions } from "#shared/tool-definition.js";

/**
 * Wraps one authored tool's `execute` with a context that supports inline
 * provider auth (`ctx.getToken(connect("..."))`).
 *
 * On a thrown provider-scoped authorization request — implicit from
 * `ctx.getToken(provider)` or explicit via `ctx.requireAuth(provider)` — the
 * wrapper either fails terminally (token rejected immediately after sign-in)
 * or evicts the rejected token from the per-step cache and starts the
 * interactive flow, returning an `AuthorizationSignal` to park the turn.
 * Interactive strategies never rethrow the raw `Required` into the model: if
 * no callback URL can be minted, they fail with a classified
 * {@link ConnectionAuthorizationFailedError} instead. Non-interactive
 * strategies rethrow the original error because they have no consent flow to
 * park on.
 */
export function createToolExecuteWithAuth(input: {
  readonly scope: string;
  readonly execute: (toolInput: unknown, ctx: unknown) => unknown;
}): (toolInput: unknown, options: ToolExecuteOptions) => Promise<unknown> {
  const { scope, execute } = input;

  return async (toolInput: unknown, options: ToolExecuteOptions): Promise<unknown> => {
    const justAuthorizedScopes = new Set<string>();

    try {
      return await execute(
        toolInput,
        buildToolContext({
          inlineAuthState: {},
          justAuthorizedScopes,
          options,
          scope,
        }),
      );
    } catch (err) {
      if (isToolAuthorizationRequiredError(err)) {
        return await handleAuthorizationRequests(err.requests);
      }

      throw err;
    }
  };
}

function buildToolContext(input: {
  readonly options: ToolExecuteOptions;
  readonly scope: string;
  readonly justAuthorizedScopes: Set<string>;
  readonly inlineAuthState: InlineAuthState;
}): ToolContext {
  const { scope, justAuthorizedScopes, inlineAuthState } = input;
  const base = buildBaseToolContext({ options: input.options, toolName: scope });
  return {
    ...base,
    async getToken(provider?: ToolAuthProvider, options?: ToolAuthOptions): Promise<TokenResult> {
      if (provider === undefined) throw missingProviderError("ctx.getToken");
      return await resolveInlineToken({
        inlineAuthState,
        justAuthorizedScopes,
        options,
        provider,
        toolScope: scope,
      });
    },
    requireAuth(provider?: ToolAuthProvider, options?: ToolAuthOptions): never {
      if (provider === undefined) throw missingProviderError("ctx.requireAuth");
      const scoped = buildInlineScopedAuthorization({
        inlineAuthState,
        options,
        provider,
        toolScope: scope,
      });
      throw new ToolAuthorizationRequiredError([
        {
          justAuthorized: justAuthorizedScopes.has(scoped.scope),
          scoped,
        },
      ]);
    },
  };
}

async function resolveInlineToken(input: {
  readonly toolScope: string;
  readonly provider: ToolAuthProvider;
  readonly options?: ToolAuthOptions;
  readonly justAuthorizedScopes: Set<string>;
  readonly inlineAuthState: InlineAuthState;
}): Promise<TokenResult> {
  const { justAuthorizedScopes } = input;
  const scoped = buildInlineScopedAuthorization(input);
  if (!justAuthorizedScopes.has(scoped.scope) && (await completeScopedAuthorization(scoped))) {
    justAuthorizedScopes.add(scoped.scope);
  }

  try {
    return await resolveScopedToken(scoped);
  } catch (err) {
    if (!isConnectionAuthorizationRequiredError(err)) throw err;
    throw new ToolAuthorizationRequiredError([
      {
        cause: err,
        justAuthorized: justAuthorizedScopes.has(scoped.scope),
        scoped,
      },
    ]);
  }
}

async function handleAuthorizationRequests(
  requests: readonly ToolAuthorizationRequiredRequest[],
): Promise<unknown> {
  const challenges: AuthorizationChallenge[] = [];
  let nonInteractiveError: Error | undefined;

  for (const request of requests) {
    const { scoped } = request;

    // Loop guard: a token minted this turn that is still rejected
    // means the grant itself is broken — fail terminally instead of
    // re-prompting into an infinite sign-in loop.
    if (request.justAuthorized) {
      throw new ConnectionAuthorizationFailedError(scoped.scope, {
        message: `Tool "${scoped.scope}" rejected the token immediately after authorization.`,
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
    if (signal !== undefined) {
      challenges.push(...signal.challenges);
      continue;
    }

    // No park signal. For an interactive strategy this means the
    // framework could not mint a callback URL (no session id / base
    // URL in context). Never let the raw `Required` reach the model —
    // it improvises by surfacing the auth URL as text and loops
    // (see research/per-tool-auth-known-issues.md, issue 2). Fail with
    // a classified, terminal authorization error instead. Non-interactive
    // strategies have no consent flow, so their original error is the
    // right thing for the model to see.
    if (supportsInteractiveAuthorization(scoped.authorization)) {
      throw new ConnectionAuthorizationFailedError(scoped.scope, {
        message:
          `Tool "${scoped.scope}" requires sign-in, but no authorization callback URL ` +
          `could be minted for this run (missing session context).`,
        reason: "authorization_callback_unavailable",
        retryable: false,
      });
    }

    nonInteractiveError ??=
      request.cause instanceof Error
        ? request.cause
        : new ConnectionAuthorizationRequiredError(scoped.scope);
  }

  if (challenges.length > 0) {
    return requestAuthorization(challenges);
  }

  throw nonInteractiveError ?? new Error("Tool authorization is required.");
}

function buildInlineScopedAuthorization(input: {
  readonly toolScope: string;
  readonly provider: ToolAuthProvider;
  readonly options?: ToolAuthOptions;
  readonly inlineAuthState: InlineAuthState;
}): ScopedAuthorization {
  const authorization = normalizeInlineProvider(input.provider, input.options);
  return {
    authorization,
    connection: input.options?.connection ?? { url: "" },
    scope:
      input.options?.authKey === undefined
        ? deriveInlineScope({
            authorization,
            inlineAuthState: input.inlineAuthState,
            provider: input.provider,
            toolScope: input.toolScope,
          })
        : validateInlineAuthKey(input.options.authKey),
  };
}

function normalizeInlineProvider(
  provider: ToolAuthProvider,
  options: ToolAuthOptions | undefined,
): AuthorizationDefinition {
  const authorization = normalizeAuthorizationSpec(provider, "ctx.getToken:", "provider");
  if (options?.displayName === undefined) {
    return authorization;
  }
  if (options.displayName.length === 0) {
    throw new Error(`ctx.getToken: The "options.displayName" field must be a non-empty string.`);
  }
  return { ...authorization, displayName: options.displayName };
}

function deriveInlineScope(input: {
  readonly toolScope: string;
  readonly authorization: AuthorizationDefinition;
  readonly provider: ToolAuthProvider;
  readonly inlineAuthState: InlineAuthState;
}): string {
  const connector = input.authorization.vercelConnect?.connector;
  if (connector !== undefined) {
    return `${input.toolScope}__${sanitizeScopeSegment(connector)}`;
  }

  if (input.inlineAuthState.anonymousProvider === undefined) {
    input.inlineAuthState.anonymousProvider = input.provider;
  } else if (input.inlineAuthState.anonymousProvider !== input.provider) {
    throw new Error(
      `ctx.getToken: Multiple inline auth providers without provider metadata need explicit auth keys. ` +
        `Pass options.authKey for each provider, for example ` +
        `ctx.getToken(auth, { authKey: "github" }).`,
    );
  }

  return `${input.toolScope}__inline_auth`;
}

function validateInlineAuthKey(authKey: string): string {
  if (!/^[A-Za-z0-9_.:-]+$/u.test(authKey)) {
    throw new Error(
      `ctx.getToken: The "options.authKey" field must contain only letters, digits, "_", "-", ".", or ":".`,
    );
  }
  return authKey;
}

function sanitizeScopeSegment(value: string): string {
  const sanitized = value.replace(/[^A-Za-z0-9_.:-]+/gu, "_").replace(/^_+|_+$/gu, "");
  return sanitized.length > 0 ? sanitized : "provider";
}

interface ToolAuthorizationRequiredRequest {
  readonly scoped: ScopedAuthorization;
  readonly justAuthorized: boolean;
  readonly cause?: unknown;
}

interface InlineAuthState {
  anonymousProvider?: ToolAuthProvider;
}

class ToolAuthorizationRequiredError extends Error {
  readonly requests: readonly ToolAuthorizationRequiredRequest[];

  constructor(requests: readonly ToolAuthorizationRequiredRequest[]) {
    super("Tool authorization required.");
    this.name = "ToolAuthorizationRequiredError";
    this.requests = requests;
  }
}

function isToolAuthorizationRequiredError(err: unknown): err is ToolAuthorizationRequiredError {
  return err instanceof Error && err.name === "ToolAuthorizationRequiredError";
}

function missingProviderError(method: "ctx.getToken" | "ctx.requireAuth"): Error {
  return new Error(
    `${method}: Pass an auth provider, for example ${method}(connect("github/myagent")).`,
  );
}
