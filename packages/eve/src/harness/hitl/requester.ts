import type { SessionAuthContext } from "#channel/types.js";
import { AuthKey, SessionKey } from "#context/keys.js";
import type { AuthorizationChallenge } from "#harness/authorization.js";
import type { Step } from "#harness/step/context.js";

/** The caller whose turn parks a step. */
export function currentRequester(step: Step): SessionAuthContext | null {
  return step.ctx?.get(AuthKey) ?? step.ctx?.get(SessionKey)?.auth.current ?? null;
}

/**
 * The turn's sign-ins, owned by its caller. A sign-in callback carries no identity, so the turn
 * resumes as the requester recorded here; it comes from the runtime's context, never from what a
 * tool returned. A responder's sign-in (`candidateId`) keeps the responder its answer bound.
 */
export function ownedSignIns(
  challenges: readonly AuthorizationChallenge[],
  requester: SessionAuthContext | null,
): readonly AuthorizationChallenge[] {
  return challenges.map((challenge) => {
    if (challenge.candidateId !== undefined) return challenge;
    const { principalId: _principalId, requester: _requester, ...rest } = challenge;
    return requester === null ? rest : { ...rest, principalId: requester.principalId, requester };
  });
}
