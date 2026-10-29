import type { AuthorizationChallenge } from "#harness/authorization.js";
import type { SignInChallenge } from "#protocol/session-events/families/interaction.js";
import { activeTurnIdOf, type SessionProjection } from "#protocol/session-projection.js";
import { interactionOwner } from "#protocol/session-projection/selectors.js";
import type { InteractionRow } from "#protocol/session-projection/tables.js";

// Which sign-in attempts replace which. Pure: the session state that holds them is
// `requests.ts`'s.

/** What makes two sign-in attempts the same one. */
interface SignInIdentity extends Pick<AuthorizationChallenge, "candidateId" | "grant" | "name"> {
  readonly principal?: SignInChallenge["principal"];
}

/** The pending sign-ins once `challenges` are asked for: each replaces the attempt it supersedes. */
export function withSignIns(
  previous: readonly AuthorizationChallenge[],
  challenges: readonly AuthorizationChallenge[],
): readonly AuthorizationChallenge[] {
  const active = resolveActiveAuthorizationChallenges(challenges);
  const superseded = supersededChallenges(previous, active);
  return [...previous.filter((challenge) => !superseded.includes(challenge)), ...active];
}

/** Keeps the last challenge for each sign-in and principal. */
export function resolveActiveAuthorizationChallenges(
  challenges: readonly AuthorizationChallenge[],
): readonly AuthorizationChallenge[] {
  return challenges.filter(
    (candidate, index) =>
      !challenges.slice(index + 1).some((replacement) => sameSignIn(candidate, replacement)),
  );
}

/** The attempts in `previous` that `replacements` replace: the same sign-in and principal. */
export function supersededChallenges(
  previous: readonly AuthorizationChallenge[],
  replacements: readonly AuthorizationChallenge[],
): readonly AuthorizationChallenge[] {
  return previous.filter((candidate) =>
    replacements.some((replacement) => sameSignIn(candidate, replacement)),
  );
}

/**
 * The sign-in this turn already tried and failed terminally (`retryable: false`) for the same
 * grant and principal as `challenge`: asking again would send the person through the same
 * failure. Calls before the turn's first sign-in failure have nothing to find.
 */
export function terminalSignInFailure(
  projection: SessionProjection,
  challenge: SignInIdentity,
): InteractionRow | undefined {
  const turnId = activeTurnIdOf(projection);
  if (turnId === undefined) return undefined;
  const view = projection.view;
  return Object.values(view.interactions).find((row) => {
    const signIn = row.request.signIn;
    return (
      signIn !== undefined &&
      row.outcome === "failed" &&
      row.response?.retryable === false &&
      interactionOwner(view, row).turnId === turnId &&
      sameSignIn(
        {
          // A responder's sign-in is about their answer: the approval candidate it settles.
          candidateId: "responseId" in row.subject ? row.subject.responseId : undefined,
          grant: signIn.grant,
          name: signIn.name,
          principal: signIn.principal,
        },
        challenge,
      )
    );
  });
}

/**
 * Same scope, or the same grant from another scope, such as two tools and a
 * connection that all use one Vercel Connect connector. Approval sign-ins
 * stay per candidate because each one settles its own approval.
 */
function sameSignIn(left: SignInIdentity, right: SignInIdentity): boolean {
  const sameGrant =
    left.grant !== undefined &&
    left.grant === right.grant &&
    left.candidateId === right.candidateId;
  return (left.name === right.name || sameGrant) && samePrincipal(left.principal, right.principal);
}

function samePrincipal(
  left: SignInIdentity["principal"],
  right: SignInIdentity["principal"],
): boolean {
  if (left === undefined || right === undefined) return left === right;
  return left.type === right.type && left.id === right.id && left.issuer === right.issuer;
}

/** The key a sign-in callback names its attempt by. */
export function signInAttemptKey(challenge: AuthorizationChallenge): string {
  return challenge.attemptId ?? challenge.candidateId ?? challenge.name;
}
