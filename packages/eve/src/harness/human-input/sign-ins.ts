/**
 * The sign-in rules. A tool call, or a responder's approval policy, that needs
 * a sign-in opens one request per attempt, keyed by the attempt's id, and the
 * turn holds until a callback closes it. The call that asked never joins
 * history: it leaves its step, so the model calls it again once the person has
 * signed in. A step whose other calls all have results joins history without
 * it; a step suspended on an approval stays suspended, out of history, until
 * the approval resolves. A newer attempt for the same sign-in replaces an
 * older one; steering or cancelling the turn declines every open sign-in.
 */
import type { ModelMessage } from "ai";

import type { SessionAuthContext } from "#channel/types.js";
import { authorizationEventFields } from "#harness/authorization-event-fields.js";
import type { AuthorizationChallenge } from "#harness/authorization.js";
import type { HumanInputEvent, HumanInputState, RequestAt } from "#harness/human-input/index.js";
import {
  createAuthorizationCompletedEvent,
  createAuthorizationRequiredEvent,
  type AuthorizationOutcome,
} from "#protocol/message.js";
import type { AuthorizationCallback, ConnectionPrincipal } from "#shared/connection-types.js";

import { withoutCalls } from "./suspended-step.js";

/** An open sign-in, as the session stores it. */
export interface OpenSignIn {
  readonly kind: "authorization";
  readonly at: RequestAt;
  readonly challenge: AuthorizationChallenge;
}

interface Reduced {
  readonly events: readonly HumanInputEvent[];
  readonly state: HumanInputState;
}

const SUPERSEDED_REASON = "Superseded by a newer authorization attempt.";

/**
 * Opens a sign-in for each challenge and holds the turn. Within one ask and
 * against the sign-ins already open, the latest attempt for a sign-in wins and
 * the older one fails as superseded. `callIds`, the calls that asked, leave
 * their step. While the step is suspended (its approvals are open, so
 * `messages` is empty: the suspended step is the step), it stays suspended
 * without them; otherwise the step's `messages` join history without them.
 */
export function requireSignIns(
  state: HumanInputState,
  input: {
    readonly at: RequestAt;
    readonly callIds: readonly string[];
    readonly challenges: readonly AuthorizationChallenge[];
    readonly messages: readonly ModelMessage[];
    readonly requester: SessionAuthContext | null;
  },
): Reduced {
  const asked = latestPerSignIn(input.challenges).map((challenge) =>
    challenge.requester !== undefined || input.requester === null
      ? challenge
      : { ...challenge, requester: input.requester },
  );
  const superseded = openSignInsOf(state).filter((open) =>
    asked.some((challenge) => sameSignIn(open.challenge, challenge)),
  );
  const requests = { ...state.requests };
  for (const open of superseded) delete requests[attemptKey(open.challenge)];
  for (const challenge of asked) {
    const signIn: OpenSignIn = { at: input.at, challenge, kind: "authorization" };
    requests[attemptKey(challenge)] = signIn;
  }
  const stopped = new Set(input.callIds);
  const events: HumanInputEvent[] = [];
  let next: HumanInputState = { ...state, requests };
  if (state.suspended !== undefined) {
    const messages = withoutCalls(state.suspended.messages, stopped);
    next = { ...next, suspended: { ...state.suspended, messages } };
  } else {
    for (const message of withoutCalls(input.messages, stopped)) {
      events.push({ message, type: "history.appended" });
    }
  }
  for (const open of superseded) {
    events.push(completed(open.challenge, input.at, "failed", SUPERSEDED_REASON));
  }
  for (const challenge of asked) {
    events.push({
      event: createAuthorizationRequiredEvent({
        ...authorizationEventFields(challenge),
        description:
          challenge.challenge.instructions ?? `Authorization required for ${challenge.name}`,
        webhookUrl: challenge.hookUrl,
        ...input.at,
      }),
      type: "publish",
    });
  }
  return { events, state: next };
}

/**
 * A callback arrived for a sign-in. A callback for an attempt that is no
 * longer open (superseded, declined, or already completed) returns
 * `undefined`: it completes nothing. Otherwise the sign-in closes, and once
 * authorized its callback goes to the call or policy that asked. A plain
 * sign-in's turn resumes as the person who started it, since the callback
 * carries no identity; a responder's sign-in binds its responder itself.
 */
export function completeSignIn(
  state: HumanInputState,
  input: {
    readonly attemptId: string;
    readonly callback?: AuthorizationCallback;
    readonly connectionName: string;
    readonly outcome: "authorized" | "failed";
  },
): (Reduced & { readonly challenge: AuthorizationChallenge }) | undefined {
  const open = state.requests[input.attemptId];
  if (open?.kind !== "authorization" || open.challenge.name !== input.connectionName) {
    return undefined;
  }
  const { challenge } = open;
  const events: HumanInputEvent[] = [completed(challenge, open.at, input.outcome)];
  if (input.outcome === "authorized" && input.callback !== undefined) {
    events.push({
      requester: challenge.candidateId === undefined ? (challenge.requester ?? null) : null,
      result: {
        attemptId: input.attemptId,
        callback: input.callback,
        hookUrl: challenge.hookUrl,
        instanceId: challenge.instanceId,
        name: challenge.name,
        principal: challenge.principal,
        resume: challenge.resume,
      },
      type: "sign-in.completed",
    });
  }
  const { [input.attemptId]: _closed, ...requests } = state.requests;
  return { challenge, events, state: { ...state, requests } };
}

/**
 * Closes the open sign-ins `which` selects, reporting each with `outcome` at
 * its own coordinates. Returns the names of the closed sign-ins the turn's own
 * calls asked for, so the model can be told which ones ended.
 */
export function closeSignIns(
  state: HumanInputState,
  input: {
    readonly outcome: AuthorizationOutcome;
    readonly reason: string;
    readonly which?: (challenge: AuthorizationChallenge) => boolean;
  },
): Reduced & { readonly names: readonly string[] } {
  const closing = openSignInsOf(state).filter(
    (open) => input.which === undefined || input.which(open.challenge),
  );
  if (closing.length === 0) return { events: [], names: [], state };
  const requests = { ...state.requests };
  for (const open of closing) delete requests[attemptKey(open.challenge)];
  const names = closing
    .filter((open) => open.challenge.candidateId === undefined)
    .map((open) => open.challenge.name);
  return {
    events: closing.map((open) => completed(open.challenge, open.at, input.outcome, input.reason)),
    names: [...new Set(names)],
    state: { ...state, requests },
  };
}

/** The attempt ids of every open sign-in, whose callbacks the turn waits for. */
export function awaitedSignIns(state: HumanInputState): readonly string[] {
  return openSignInsOf(state).flatMap((open) =>
    open.challenge.attemptId === undefined ? [] : [open.challenge.attemptId],
  );
}

/** Whether a responder's candidate still waits on a sign-in. */
export function waitsOnSignIn(state: HumanInputState, candidateId: string): boolean {
  return openSignInsOf(state).some((open) => open.challenge.candidateId === candidateId);
}

function openSignInsOf(state: HumanInputState): OpenSignIn[] {
  return Object.values(state.requests).filter(
    (open): open is OpenSignIn => open.kind === "authorization",
  );
}

/** A callback names its attempt; challenges minted before attempts existed fall back. */
function attemptKey(challenge: AuthorizationChallenge): string {
  return challenge.attemptId ?? challenge.candidateId ?? challenge.name;
}

function latestPerSignIn(
  challenges: readonly AuthorizationChallenge[],
): readonly AuthorizationChallenge[] {
  return challenges.filter(
    (candidate, index) =>
      !challenges.slice(index + 1).some((replacement) => sameSignIn(candidate, replacement)),
  );
}

/**
 * Same scope, or the same grant from another scope, such as two tools and a
 * connection that all use one Vercel Connect connector. Responders' sign-ins
 * stay per candidate because each one settles its own approval.
 */
function sameSignIn(left: AuthorizationChallenge, right: AuthorizationChallenge): boolean {
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

function completed(
  challenge: AuthorizationChallenge,
  at: RequestAt,
  outcome: AuthorizationOutcome,
  reason?: string,
): HumanInputEvent {
  return {
    event: createAuthorizationCompletedEvent({
      ...authorizationEventFields(challenge),
      outcome,
      ...(reason !== undefined && { reason }),
      ...at,
    }),
    type: "publish",
  };
}
