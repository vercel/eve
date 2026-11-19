import type { AuthorizationChallenge } from "#harness/authorization.js";
import type {
  InteractionOpenedData,
  SignInChallenge,
} from "#protocol/session-events/families/interaction.js";
import { activeTurnIdOf, type SessionProjection } from "#protocol/session-projection.js";
import { interactionOwner } from "#protocol/session-projection/selectors.js";
import type { InteractionRow, SessionView } from "#protocol/session-projection/tables.js";

export const SIGN_IN_DECLINED = "access_denied";

interface SignInIdentity extends Pick<AuthorizationChallenge, "candidateId" | "grant" | "name"> {
  readonly principal?: SignInChallenge["principal"];
}

export function withSignIns(
  previous: readonly AuthorizationChallenge[],
  challenges: readonly AuthorizationChallenge[],
): readonly AuthorizationChallenge[] {
  const active = resolveActiveAuthorizationChallenges(challenges);
  const superseded = supersededChallenges(previous, active);
  return [...previous.filter((challenge) => !superseded.includes(challenge)), ...active];
}

export function resolveActiveAuthorizationChallenges(
  challenges: readonly AuthorizationChallenge[],
): readonly AuthorizationChallenge[] {
  return challenges.filter(
    (candidate, index) =>
      !challenges.slice(index + 1).some((replacement) => sameSignIn(candidate, replacement)),
  );
}

export function supersededChallenges(
  previous: readonly AuthorizationChallenge[],
  replacements: readonly AuthorizationChallenge[],
): readonly AuthorizationChallenge[] {
  return previous.filter((candidate) =>
    replacements.some((replacement) => sameSignIn(candidate, replacement)),
  );
}

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

function sameSignIn(left: SignInIdentity, right: SignInIdentity): boolean {
  const sameGrant =
    left.grant !== undefined &&
    left.grant === right.grant &&
    left.candidateId === right.candidateId;
  return (left.name === right.name || sameGrant) && samePrincipal(left.principal, right.principal);
}

export function sameRelayedSignIn(left: SignInChallenge, right: SignInChallenge): boolean {
  return (
    left.grant !== undefined &&
    left.grant === right.grant &&
    samePrincipal(left.principal, right.principal) &&
    callbackOrigin(left.callbackUrl) !== undefined &&
    callbackOrigin(left.callbackUrl) === callbackOrigin(right.callbackUrl)
  );
}

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

export function signInAttemptKey(challenge: AuthorizationChallenge): string {
  return challenge.attemptId ?? challenge.candidateId ?? challenge.name;
}
