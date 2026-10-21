import { failedSignIn, isConnectionAuthorizationFailedError } from "#connections/errors.js";
import type { AuthorizationChallenge } from "#harness/authorization.js";
import type { AuthorizationPrincipal } from "#protocol/message.js";
import type { ConnectionPrincipal } from "#shared/connection-types.js";

/**
 * Fields every `authorization.*` event copies from its challenge. Emitters
 * spread this and add only event-local fields, so a new challenge-derived
 * field reaches every event at once.
 */
export function authorizationEventFields(challenge: AuthorizationChallenge) {
  return {
    attemptId: challenge.attemptId,
    authorization: challenge.challenge,
    candidateId: challenge.candidateId,
    grant: challenge.grant,
    name: challenge.name,
    principal: principalIdentity(challenge.principal),
    principalId: challenge.principalId,
  };
}

/**
 * The `authorization.completed` fields of the sign-in `challenge` once its call failed with
 * `failure`. Only the sign-in that raised a failure carries its `retryable`: another sign-in's
 * failure says nothing about whether this one can be retried.
 */
export function failedSignInFields(
  challenge: Pick<AuthorizationChallenge, "name">,
  failure: unknown,
) {
  const reason = isConnectionAuthorizationFailedError(failure)
    ? (failure.reason ?? failure.message)
    : failure instanceof Error
      ? failure.message
      : typeof failure === "string"
        ? failure
        : undefined;
  return {
    outcome: "failed" as const,
    ...(reason !== undefined && { reason }),
    ...(isConnectionAuthorizationFailedError(failure) &&
      failedSignIn(failure) === challenge.name && { retryable: failure.retryable }),
  };
}

/** The connection principal without its attributes, which events don't carry. */
function principalIdentity(
  principal: ConnectionPrincipal | undefined,
): AuthorizationPrincipal | undefined {
  if (principal === undefined) return undefined;
  if (principal.type === "app") return { type: "app" };
  return principal.issuer === undefined
    ? { id: principal.id, type: "user" }
    : { id: principal.id, issuer: principal.issuer, type: "user" };
}
