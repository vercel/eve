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
