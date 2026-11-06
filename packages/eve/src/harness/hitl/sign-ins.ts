import type { AuthorizationChallenge } from "#harness/authorization.js";
import type {
  InteractionOpenedData,
  SignInChallenge,
} from "#protocol/session-events/families/interaction.js";
import { activeTurnIdOf, type SessionProjection } from "#protocol/session-projection.js";
import { interactionOwner } from "#protocol/session-projection/selectors.js";
import type { InteractionRow, SessionView } from "#protocol/session-projection/tables.js";

// Which sign-in attempts replace which. Pure: the session state that holds them is
// `requests.ts`'s.

/** The failure `reason` of a sign-in the person declined at the provider (RFC 6749 `access_denied`). */
export const SIGN_IN_DECLINED = "access_denied";

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
 * The sign-in that rules out asking again for the same grant and principal as `challenge`. In
 * this turn, that is one that ended without being completed, other than a retryable failure or an
 * invalid callback (see `rulesOutReasking`), such as one a new message withdrew.
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
    if (signIn === undefined) return false;
    return (
      interactionOwner(view, row).turnId === turnId &&
      rulesOutReasking(row) &&
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
 * Whether a settled sign-in rules out asking for it again in its turn. Only a completed sign-in,
 * a failure the provider says is worth retrying, and an invalid callback (not the person's
 * answer) leave the turn free to ask again.
 */
function rulesOutReasking(row: InteractionRow): boolean {
  const { outcome } = row;
  switch (outcome) {
    case undefined:
    case "accepted":
    case "invalid":
      return false;
    case "failed":
      return row.response?.retryable === false;
    case "declined":
    case "withdrawn":
    case "interrupted":
    case "abandoned":
    case "expired":
      return true;
    default: {
      const _exhaustive: never = outcome;
      return _exhaustive;
    }
  }
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

/**
 * Whether one completion serves both relayed sign-ins: the same Vercel Connect grant for the same
 * principal, minted by the same deployment. Connect stores the grant once, and each asker reads it
 * for its own principal, so calling either one's callback completes it. A sign-in without a grant
 * needs the code its own callback carries, so another's answer never completes it.
 */
export function sameRelayedSignIn(left: SignInChallenge, right: SignInChallenge): boolean {
  return (
    left.grant !== undefined &&
    left.grant === right.grant &&
    samePrincipal(left.principal, right.principal) &&
    callbackOrigin(left.callbackUrl) !== undefined &&
    callbackOrigin(left.callbackUrl) === callbackOrigin(right.callbackUrl)
  );
}

/**
 * A sign-in opening with the attempt it waits on: the open one for the same grant and principal
 * the person already has a card for (`sameRelayedSignIn`), other than the ones in `closing`. Its
 * record and callback stay, and the answer to that card completes it too, so it waits only when
 * this session can call its callback (`callsBack`); any other keeps its own card. A
 * responder's sign-in is about its own answer, so it always has its own card.
 */
export function waitingSignIn(
  view: SessionView,
  data: InteractionOpenedData,
  callsBack: CallsBack | undefined,
  closing: ReadonlySet<string> = new Set(),
): InteractionOpenedData {
  const signIn = data.request.signIn;
  if (
    signIn === undefined ||
    signIn.waitsOn !== undefined ||
    "responseId" in data.subject ||
    callsBack === undefined ||
    !callsBack(data)
  )
    return data;
  const shown = Object.values(view.interactions).find(
    (row) =>
      row.status === "open" &&
      !closing.has(row.interactionId) &&
      !("responseId" in row.subject) &&
      row.request.signIn !== undefined &&
      row.request.signIn.waitsOn === undefined &&
      sameRelayedSignIn(row.request.signIn, signIn),
  );
  return shown === undefined
    ? data
    : {
        ...data,
        request: { ...data.request, signIn: { ...signIn, waitsOn: shown.interactionId } },
      };
}

/** Whether this session can call a sign-in's callback, and so complete it from another's answer. */
export type CallsBack = (row: Pick<InteractionRow, "origin" | "request">) => boolean;

function callbackOrigin(url: string | undefined): string | undefined {
  if (url === undefined || !URL.canParse(url)) return undefined;
  return new URL(url).origin;
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
