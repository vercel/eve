import type { AuthorizationChallenge } from "#harness/authorization.js";

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
    name: challenge.name,
    principalId: challenge.principalId,
  };
}
