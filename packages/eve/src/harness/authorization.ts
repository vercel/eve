import {
  sessionCommandHookToken,
  sessionInboxHookToken,
} from "#execution/session-inbox/address.js";

import { loadContext } from "#context/container.js";
import { ContextKey } from "#context/key.js";
import { SessionIdKey, type SessionAuthContext } from "#context/keys.js";
import { createBrowserCallbackUrl } from "#execution/workflow-callback-url.js";
import type { ConnectionAuthorizationChallenge } from "#connections/errors.js";
import type { AuthorizationCallback, ConnectionPrincipal } from "#shared/connection-types.js";
import type { JsonValue } from "#shared/json.js";
import { createEveConnectionCallbackRoutePath } from "#protocol/routes.js";
import { createUlid } from "#shared/ulid.js";

const AUTHORIZATION_PENDING_BRAND = "__eveAuthorizationPending" as const;

const AUTHORIZATION_SIGNAL: unique symbol = Symbol.for("eve.authorizationSignal");

export interface AuthorizationChallenge {
  readonly attemptId?: string;
  readonly candidateId?: string;
  readonly grant?: string;
  readonly instanceId?: string;
  readonly name: string;
  readonly challenge: ConnectionAuthorizationChallenge;
  readonly hookUrl: string;
  readonly principal?: ConnectionPrincipal;
  readonly principalId?: string;
  readonly requester?: SessionAuthContext;
  readonly resume?: JsonValue;
}

export interface AuthorizationSignal {
  readonly [AUTHORIZATION_SIGNAL]: true;
  readonly challenges: readonly AuthorizationChallenge[];
}

export interface AuthorizationPendingModelOutput {
  readonly [AUTHORIZATION_PENDING_BRAND]: true;
  readonly connections: readonly string[];
}

export interface AuthorizationResult {
  readonly attemptId?: string;
  readonly instanceId?: string;
  readonly resume?: JsonValue;
  readonly callback: AuthorizationCallback;
  readonly hookUrl: string;
  readonly principal?: ConnectionPrincipal;
}

export function requestAuthorization(
  challenges: readonly AuthorizationChallenge[],
): AuthorizationSignal {
  return { [AUTHORIZATION_SIGNAL]: true, challenges };
}

export function getAuthorizationResult(name?: string): AuthorizationResult | undefined {
  const results = loadContext().get(PendingAuthorizationResultKey);
  if (!results || results.length === 0) return undefined;
  if (name === undefined) return results[0];
  return results.find((r) => r.name === name);
}

export function getAuthorizationResults(): readonly NamedAuthorizationResult[] {
  return loadContext().get(PendingAuthorizationResultKey) ?? [];
}

export function consumeAuthorizationResult(
  name: string,
  instanceId?: string,
): AuthorizationResult | undefined {
  const ctx = loadContext();
  const results = ctx.get(PendingAuthorizationResultKey);
  if (!results || results.length === 0) return undefined;

  const index = results.findIndex(
    (result) => result.name === name && result.instanceId === instanceId,
  );
  if (
    index === -1 &&
    instanceId !== undefined &&
    results.some((result) => result.name === name && result.instanceId !== undefined)
  ) {
    throw new Error(
      `Authorization for "${name}" cannot complete because its resolved connection changed while sign-in was pending. Start sign-in again.`,
    );
  }
  if (index === -1) return undefined;

  const result = results[index]!;
  const remaining = results.filter((_, resultIndex) => resultIndex !== index);
  ctx.delete(PendingAuthorizationResultKey);
  if (remaining.length > 0) {
    ctx.set(PendingAuthorizationResultKey, remaining);
  }
  return result;
}

export function getHookUrl(name: string, attemptId: string): string | undefined {
  const ctx = loadContext();
  const sessionId = ctx.get(SessionIdKey);
  const baseUrl = ctx.get(CallbackBaseUrlKey);
  const token = ctx.get(AuthorizationHookKey) ?? (sessionId ? authHookToken(sessionId) : undefined);
  if (!token || !baseUrl) return undefined;
  return createBrowserCallbackUrl(
    baseUrl,
    createEveConnectionCallbackRoutePath(name, attemptId, token),
  );
}

export function createAuthorizationAttempt(
  name: string,
): { readonly attemptId: string; readonly hookUrl: string } | undefined {
  const attemptId = createUlid();
  const hookUrl = getHookUrl(name, attemptId);
  return hookUrl === undefined ? undefined : { attemptId, hookUrl };
}

export function isAuthorizationSignal(value: unknown): value is AuthorizationSignal {
  if (typeof value !== "object" || value === null) return false;
  return (value as { readonly [AUTHORIZATION_SIGNAL]?: unknown })[AUTHORIZATION_SIGNAL] === true;
}

export function isAuthorizationPendingModelOutput(
  value: unknown,
): value is AuthorizationPendingModelOutput {
  if (typeof value !== "object" || value === null) return false;
  return (value as Record<string, unknown>)[AUTHORIZATION_PENDING_BRAND] === true;
}

export function authorizationPendingAsJsonObject(input: {
  readonly connections: readonly string[];
}): AuthorizationPendingModelOutput {
  return {
    [AUTHORIZATION_PENDING_BRAND]: true,
    connections: [...input.connections],
  };
}

export function modelFacingAuthorizationOutput(
  signal: AuthorizationSignal,
): AuthorizationPendingModelOutput {
  return authorizationPendingAsJsonObject({
    connections: signal.challenges.map((entry) => entry.name),
  });
}

export function authorizationPendingModelText(connections: readonly string[]): string {
  if (connections.length === 0) {
    return "Authorization required. Waiting for the user to sign in.";
  }
  if (connections.length === 1) {
    return `Authorization required for ${connections[0]}. Waiting for the user to sign in.`;
  }
  return `Authorization required for ${connections.join(", ")}. Waiting for the user to sign in.`;
}

export function authHookToken(sessionId: string): string {
  return sessionInboxHookToken(sessionCommandHookToken(sessionId));
}

interface NamedAuthorizationResult extends AuthorizationResult {
  readonly name: string;
}

export const PendingAuthorizationResultKey = new ContextKey<readonly NamedAuthorizationResult[]>(
  "eve.pendingAuthorizationResult",
);

export type SignInCompleted = (result: AuthorizationResult, failure?: Error) => Promise<void>;

export const SignInCompletedKey = new ContextKey<SignInCompleted>("eve.signInCompleted");

export const CallbackBaseUrlKey = new ContextKey<string>("eve.callbackBaseUrl");

export const AuthorizationHookKey = new ContextKey<string>("eve.authorizationHook");
