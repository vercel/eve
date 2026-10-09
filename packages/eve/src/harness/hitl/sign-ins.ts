import type { AuthorizationChallenge } from "#harness/authorization.js";
import type { ConnectionPrincipal } from "#shared/connection-types.js";

// Which sign-in attempts replace which. Pure: the session state that holds them is
// `session-state.ts`'s.

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
 * Same scope, or the same grant from another scope, such as two tools and a
 * connection that all use one Vercel Connect connector. Approval sign-ins
 * stay per candidate because each one settles its own approval.
 */
function sameSignIn(
  left: Pick<AuthorizationChallenge, "candidateId" | "grant" | "name" | "principal">,
  right: Pick<AuthorizationChallenge, "candidateId" | "grant" | "name" | "principal">,
): boolean {
  const sameGrant =
    left.grant !== undefined &&
    left.grant === right.grant &&
    left.candidateId === right.candidateId;
  return (left.name === right.name || sameGrant) && samePrincipal(left.principal, right.principal);
}

function samePrincipal(
  left: ConnectionPrincipal | undefined,
  right: ConnectionPrincipal | undefined,
): boolean {
  if (left === undefined || right === undefined) return left === right;
  if (left.type === "app" || right.type === "app") return left.type === right.type;
  return left.id === right.id && left.issuer === right.issuer;
}
