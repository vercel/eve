import { type AlsContext, contextStorage, loadContext } from "#context/container.js";
import {
  type ConnectionAuthorizationChallenge,
  ConnectionAuthorizationFailedError,
  ConnectionAuthorizationRequiredError,
  isConnectionAuthorizationRequiredError,
} from "#connections/errors.js";
import { isAsyncIterable } from "#shared/async-iterable.js";
import {
  type AuthorizationSignal,
  consumeAuthorizationResult,
  createAuthorizationAttempt,
  requestAuthorization,
  SignInCompletedKey,
} from "#harness/authorization.js";
import { toError } from "#shared/errors.js";
import type { JsonValue } from "#shared/json.js";
import {
  evictCachedToken,
  readCachedToken,
  writeCachedToken,
} from "#runtime/connections/authorization-tokens.js";
import {
  principalKey,
  resolveConnectionPrincipal,
  resolveConnectionPrincipalFromAuth,
} from "#runtime/connections/principal.js";
import { liveProjection } from "#harness/session-machine/current.js";
import { SIGN_IN_DECLINED, terminalSignInFailure } from "#harness/hitl/sign-ins.js";
import { AuthKey, type SessionAuthContext } from "#context/keys.js";
import { readSessionSchedule } from "#context/session-schedule.js";
import {
  type AuthorizationDefinition,
  type ConnectionAuthorizationContext,
  type InteractiveAuthorizationDefinition,
  supportsInteractiveAuthorization,
  type TokenResult,
} from "#shared/connection-types.js";

const LOCAL_HTTP_VERCEL_CONNECT_HOSTNAMES: ReadonlySet<string> = new Set(["127.0.0.1", "[::1]"]);

export interface ScopedAuthorization {
  readonly boundResponder?: SessionAuthContext;
  readonly instanceId?: string;
  readonly scope: string;
  readonly authorization: Readonly<AuthorizationDefinition>;
  readonly connection: ConnectionAuthorizationContext;
}

export function createAuthorizationExecution(
  options: {
    readonly completeAuthorization?: typeof completeScopedAuthorization;
  } = {},
) {
  const justAuthorized = new Set<string>();

  async function complete(scoped: ScopedAuthorization): Promise<void> {
    const key = scoped.instanceId ?? scoped.scope;
    if (
      !justAuthorized.has(key) &&
      (await (options.completeAuthorization ?? completeScopedAuthorization)(scoped))
    ) {
      justAuthorized.add(key);
    }
  }

  function requireAuth(scoped: ScopedAuthorization, cause?: unknown): never {
    throw new ScopedAuthorizationRequiredError(
      scoped,
      justAuthorized.has(scoped.instanceId ?? scoped.scope),
      cause,
    );
  }

  return {
    complete,
    isJustAuthorized(scoped: ScopedAuthorization): boolean {
      return justAuthorized.has(scoped.instanceId ?? scoped.scope);
    },
    async getToken(scoped: ScopedAuthorization): Promise<TokenResult> {
      await complete(scoped);
      try {
        return await resolveScopedToken(scoped);
      } catch (error) {
        if (!isConnectionAuthorizationRequiredError(error)) {
          throw error;
        }
        return requireAuth(scoped, error);
      }
    },
    async getResponderToken(scoped: ScopedAuthorization): Promise<TokenResult> {
      try {
        return await resolveScopedToken(scoped);
      } catch (error) {
        if (!isConnectionAuthorizationRequiredError(error)) {
          throw error;
        }
        throw new ConnectionAuthorizationFailedError(scoped.scope, {
          message: `The approver of "${scoped.scope}" has no token for this provider, and an approved call doesn't start a sign-in.`,
          reason: "approver_authorization_required",
          retryable: false,
        });
      }
    },
    requireAuth,
    async handleError(error: unknown, scoped?: ScopedAuthorization): Promise<AuthorizationSignal> {
      if (scoped !== undefined && isConnectionAuthorizationRequiredError(error)) {
        return await handleAuthorizationError(
          new ScopedAuthorizationRequiredError(
            scoped,
            justAuthorized.has(scoped.instanceId ?? scoped.scope),
            error,
          ),
          { evictToken: false },
        );
      }
      return await handleAuthorizationError(error);
    },
    run: executeWithAuthorization,
  };
}

class ScopedAuthorizationRequiredError extends Error {
  readonly scoped: ScopedAuthorization;
  readonly justAuthorized: boolean;

  constructor(scoped: ScopedAuthorization, justAuthorized: boolean, cause?: unknown) {
    super("Authorization required.", { cause });
    this.name = "ScopedAuthorizationRequiredError";
    this.scoped = scoped;
    this.justAuthorized = justAuthorized;
  }
}

export type { ScopedAuthorizationRequiredError };

export function isScopedAuthorizationRequiredError(
  error: unknown,
): error is ScopedAuthorizationRequiredError {
  return error instanceof Error && error.name === "ScopedAuthorizationRequiredError";
}

export async function handleAuthorizationError(
  error: unknown,
  options: { readonly evictToken: boolean } = { evictToken: true },
): Promise<AuthorizationSignal> {
  if (!isScopedAuthorizationRequiredError(error)) {
    throw error;
  }
  const { scoped } = error;
  if (error.justAuthorized) {
    throw new ConnectionAuthorizationFailedError(scoped.scope, {
      message: `Authorization for "${scoped.scope}" failed: the service rejected the token immediately after authorization.`,
      reason: "token_rejected_after_authorization",
      retryable: false,
    });
  }

  const store = contextStorage.getStore();
  if (
    store !== undefined &&
    readSessionSchedule(store) !== undefined &&
    supportsInteractiveAuthorization(scoped.authorization)
  ) {
    throw new ConnectionAuthorizationFailedError(scoped.scope, {
      message: `Sign-in to "${scoped.scope}" isn't asked for in a scheduled run. Tell the user this action needs ${scoped.scope} access, and that they can sign in by asking for it in a conversation.`,
      reason: "sign_in_unavailable",
      retryable: false,
    });
  }

  const projection = liveProjection();
  const refused =
    projection === undefined
      ? undefined
      : terminalSignInFailure(projection, {
          grant: scoped.authorization.vercelConnect?.connector,
          name: scoped.scope,
          principal: resolveScopedPrincipal(scoped),
        });
  if (refused !== undefined && refused.outcome !== "failed") {
    throw new ConnectionAuthorizationFailedError(scoped.scope, {
      message: `Sign-in to "${scoped.scope}" ended without being completed in this turn, so it won't be asked for again. Tell the user this action needs ${scoped.scope} access, and that they can ask for it again to sign in.`,
      reason: "sign_in_cancelled",
      retryable: false,
    });
  }
  if (refused !== undefined) {
    throw new ConnectionAuthorizationFailedError(scoped.scope, {
      message: `Authorization for "${scoped.scope}" already failed in this turn and can't be retried${refused.reason === undefined ? "." : `: ${refused.reason}`}`,
      ...(refused.reason !== undefined && { reason: refused.reason }),
      retryable: false,
    });
  }

  if (options.evictToken) {
    await evictScopedToken(scoped);
  }
  const signal = await startScopedAuthorization(scoped);
  if (signal !== undefined) {
    return signal;
  }

  if (supportsInteractiveAuthorization(scoped.authorization)) {
    throw new ConnectionAuthorizationFailedError(scoped.scope, {
      message: `Authorization for "${scoped.scope}" requires sign-in, but no authorization callback URL could be minted for this run (missing session context).`,
      reason: "authorization_callback_unavailable",
      retryable: false,
    });
  }
  throw error.cause ?? new ConnectionAuthorizationRequiredError(scoped.scope);
}

function executeWithAuthorization(
  execute: () => unknown,
): Promise<unknown> | AsyncIterable<unknown> {
  try {
    const output = execute();
    return isAsyncIterable(output)
      ? handleIterable(output)
      : Promise.resolve(output).catch(handleAuthorizationError);
  } catch (error) {
    return handleAuthorizationError(error);
  }
}

async function* handleIterable(output: AsyncIterable<unknown>): AsyncIterable<unknown> {
  try {
    for await (const value of output) {
      yield value;
    }
  } catch (error) {
    yield await handleAuthorizationError(error);
  }
}

export async function resolveScopedToken(input: ScopedAuthorization): Promise<TokenResult> {
  const { scope, authorization, connection } = input;
  const cacheScope = input.instanceId ?? scope;

  const ctx = contextStorage.getStore();
  const principal = resolveScopedPrincipal(input, ctx);

  if (ctx === undefined) {
    return await authorization.getToken({ connection, principal });
  }

  const key = principalKey(principal);
  const cached = readCachedToken(ctx, cacheScope, key);
  if (cached !== undefined) return cached;

  const result = await authorization.getToken({ connection, principal });
  writeCachedToken(ctx, cacheScope, key, result);
  return result;
}

export async function evictScopedToken(input: ScopedAuthorization): Promise<void> {
  const { scope, authorization, connection } = input;
  const cacheScope = input.instanceId ?? scope;
  const ctx = contextStorage.getStore();
  if (ctx === undefined) return;
  let principal;
  try {
    principal = resolveScopedPrincipal(input, ctx);
    evictCachedToken(ctx, cacheScope, principalKey(principal));
  } catch {
    return;
  }
  try {
    await authorization.evict?.({ connection, principal });
  } catch {}
}

export async function completeScopedAuthorization(input: ScopedAuthorization): Promise<boolean> {
  const { scope, authorization, connection } = input;
  if (!supportsInteractiveAuthorization(authorization)) return false;

  const result = consumeAuthorizationResult(scope, input.instanceId);
  if (result === undefined) return false;

  const ctx: AlsContext = loadContext();
  const report = ctx.get(SignInCompletedKey);
  try {
    if (result.callback.params.error === SIGN_IN_DECLINED)
      throw new ConnectionAuthorizationFailedError(scope, {
        message: `Sign-in to "${scope}" was declined.`,
        reason: SIGN_IN_DECLINED,
        retryable: false,
      });
    const interactive = authorization as InteractiveAuthorizationDefinition<JsonValue>;
    const principal = result.principal ?? resolveScopedPrincipal(input, ctx);
    const token = await interactive.completeAuthorization({
      callbackUrl: result.hookUrl,
      connection,
      principal,
      resume: result.resume,
      callback: result.callback,
    });
    writeCachedToken(ctx, input.instanceId ?? scope, principalKey(principal), token);
  } catch (error) {
    await report?.(result, toError(error));
    throw error;
  }
  await report?.(result);
  return true;
}

async function startScopedAuthorization(
  input: ScopedAuthorization,
): Promise<AuthorizationSignal | undefined> {
  const { scope, authorization, connection } = input;
  if (!supportsInteractiveAuthorization(authorization)) return undefined;

  const attempt = createAuthorizationAttempt(scope);
  if (attempt === undefined) return undefined;

  const interactive = authorization as InteractiveAuthorizationDefinition<JsonValue>;
  const principal = resolveScopedPrincipal(input);
  const requester = input.boundResponder ?? contextStorage.getStore()?.get(AuthKey) ?? undefined;
  const callbackUrl = resolveAuthorizationCallbackUrl({
    authorization,
    callbackUrl: attempt.hookUrl,
  });
  const { challenge, resume } = await interactive.startAuthorization({
    callbackUrl,
    connection,
    principal,
  });
  return requestAuthorization([
    {
      attemptId: attempt.attemptId,
      challenge: stampChallengeDisplayName(challenge, authorization),
      grant: authorization.vercelConnect?.connector,
      hookUrl: callbackUrl,
      instanceId: input.instanceId,
      name: scope,
      principal,
      principalId: requester?.principalId,
      requester,
      resume,
    },
  ]);
}

function resolveScopedPrincipal(input: ScopedAuthorization, ctx?: AlsContext) {
  return input.boundResponder === undefined
    ? resolveConnectionPrincipal(input.scope, input.authorization, ctx)
    : resolveConnectionPrincipalFromAuth(
        input.scope,
        input.authorization,
        input.boundResponder,
        ctx,
      );
}

export function resolveAuthorizationCallbackUrl(input: {
  readonly authorization: Readonly<AuthorizationDefinition>;
  readonly callbackUrl: string;
}): string {
  if (input.authorization.vercelConnect === undefined) return input.callbackUrl;
  return vercelConnectCallbackUrl(input.callbackUrl);
}

export function vercelConnectCallbackUrl(callbackUrl: string): string {
  let url: URL;
  try {
    url = new URL(callbackUrl);
  } catch {
    return callbackUrl;
  }

  if (url.protocol !== "http:" || !LOCAL_HTTP_VERCEL_CONNECT_HOSTNAMES.has(url.hostname)) {
    return callbackUrl;
  }

  url.hostname = "localhost";
  return url.toString();
}

export function stampChallengeDisplayName(
  challenge: ConnectionAuthorizationChallenge,
  authorization: Readonly<AuthorizationDefinition>,
): ConnectionAuthorizationChallenge {
  const displayName = authorization.displayName ?? challenge.displayName;
  if (displayName === challenge.displayName) return challenge;
  return { ...challenge, displayName };
}
