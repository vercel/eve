import type { SessionView } from "#harness/session-machine/view.js";
import { turnPosition } from "#harness/session-machine/view.js";
import { heldStep, withHeldStep } from "./approval.js";
// The authorization request rules; the authorization primitives (challenges, results) live in harness/authorization.ts.
/**
 * The authorization rules. A tool call that needs an authorization opens one request per
 * attempt, keyed by the attempt's id, and the turn waits until a callback
 * closes it. (A responder's approval policy that needs one keeps its
 * candidate waiting instead; see candidates.) The call that asked never joins
 * history: it leaves its step, so the model calls it again once the person has
 * authorized. A step whose other calls all have results joins history without
 * it; a step held on an approval or on runtime calls stays held, out
 * of history, until those calls have results. A newer attempt for the same authorization replaces an
 * older one; steering or cancelling the turn declines every open authorization.
 */
import type { ModelMessage } from "ai";

import type { SessionAuthContext } from "#channel/types.js";
import { authorizationEventFields } from "#harness/authorization-event-fields.js";
import type { AuthorizationChallenge } from "#harness/authorization.js";
import type { Command } from "#harness/hitl/command.js";
import type { RequestAt } from "#harness/hitl/input.js";
import type { Reduced, OpenAuthorization } from "#harness/hitl/record.js";
import {
  createAuthorizationCompletedEvent,
  createAuthorizationRequiredEvent,
  type AuthorizationOutcome,
} from "#protocol/message.js";
import type { AuthorizationCallback, ConnectionPrincipal } from "#shared/connection-types.js";

import { withoutCalls } from "./held-step.js";

const SUPERSEDED_REASON = "Superseded by a newer authorization attempt.";

/**
 * A model step's calls need authorizations: `callIds`, the calls that asked, leave
 * their step, and an authorization opens for each challenge (see `openAuthorizations`).
 * While the step is held (the held step is the step), it stays
 * held without them; otherwise the step's `messages` join history
 * without them.
 */
export function requireAuthorizations(
  state: SessionView,
  input: {
    readonly at: RequestAt;
    readonly callIds: readonly string[];
    readonly challenges: readonly AuthorizationChallenge[];
    readonly messages: readonly ModelMessage[];
    readonly requester: SessionAuthContext | null;
  },
): Reduced {
  const stopped = new Set(input.callIds);
  if (heldStep(state) !== undefined) {
    const messages = withoutCalls(heldStep(state)!.messages, stopped);
    return openAuthorizations(withHeldStep(state, { ...heldStep(state)!, messages }), input);
  }
  const opened = openAuthorizations(state, input);
  const appended: Command[] = withoutCalls(input.messages, stopped).map((message) => ({
    message,
    type: "appendHistory",
  }));
  return { events: [...appended, ...opened.events], state: opened.state };
}

/**
 * Opens an authorization for each challenge and the turn waits. Within one ask and
 * against the authorizations already open, the latest attempt for an authorization wins and
 * the older one fails as superseded. A challenge without a requester asks for
 * `requester`.
 */
export function openAuthorizations(
  state: SessionView,
  input: {
    readonly at: RequestAt;
    readonly challenges: readonly AuthorizationChallenge[];
    readonly requester: SessionAuthContext | null;
  },
): Reduced {
  const asked = latestPerAuthorization(input.challenges).map((challenge) =>
    challenge.requester !== undefined || input.requester === null
      ? challenge
      : { ...challenge, requester: input.requester },
  );
  const superseded = openAuthorizationsOf(state).filter((open) =>
    asked.some((challenge) => sameAuthorization(open.challenge, challenge)),
  );
  const supersededKeys = new Set(superseded.map((open) => attemptKey(open.challenge)));
  const signIns = [
    ...state.signIns.filter((challenge) => !supersededKeys.has(attemptKey(challenge))),
    ...asked,
  ];
  const events: Command[] = [];
  for (const open of superseded) {
    events.push(completed(open.challenge, input.at, "failed", SUPERSEDED_REASON));
  }
  for (const challenge of asked) events.push(authorizationRequested(challenge, input.at));
  return { events, state: { ...state, signIns } };
}

/** The `authorization.required` an authorization publishes as it opens. */
export function authorizationRequested(challenge: AuthorizationChallenge, at: RequestAt): Command {
  return {
    event: createAuthorizationRequiredEvent({
      ...authorizationEventFields(challenge),
      description:
        challenge.challenge.instructions ?? `Authorization required for ${challenge.name}`,
      webhookUrl: challenge.hookUrl,
      ...at,
    }),
    type: "publish",
  };
}

/**
 * A callback arrived for an authorization. A callback for an attempt that is no
 * longer open (superseded, declined, or already completed) returns
 * `undefined`: it completes nothing. Otherwise the authorization closes, and once
 * authorized its callback goes to the call that asked. The turn resumes as
 * the person who started it, since the callback carries no identity.
 */
export function completeAuthorization(
  state: SessionView,
  input: {
    readonly attemptId: string;
    readonly callback?: AuthorizationCallback;
    readonly connectionName: string;
    readonly outcome: "authorized" | "failed";
  },
): Reduced | undefined {
  const open = openAuthorizationsOf(state).find(
    (open) => attemptKey(open.challenge) === input.attemptId,
  );
  if (open?.kind !== "authorization" || open.challenge.name !== input.connectionName) {
    return undefined;
  }
  const { challenge } = open;
  const events: Command[] = [completed(challenge, open.at, input.outcome)];
  if (input.outcome === "authorized" && input.callback !== undefined) {
    events.push({
      requester: challenge.requester ?? null,
      result: {
        attemptId: input.attemptId,
        callback: input.callback,
        hookUrl: challenge.hookUrl,
        instanceId: challenge.instanceId,
        name: challenge.name,
        principal: challenge.principal,
        resume: challenge.resume,
      },
      type: "resumeAuthorization",
    });
  }
  return {
    events,
    state: {
      ...state,
      signIns: state.signIns.filter((challenge) => attemptKey(challenge) !== input.attemptId),
    },
  };
}

/**
 * Closes the open authorizations `which` selects, reporting each with `outcome` at
 * its own coordinates. Returns the names of the closed authorizations the turn's own
 * calls asked for, so the model can be told which ones ended.
 */
export function closeAuthorizations(
  state: SessionView,
  input: {
    readonly outcome: AuthorizationOutcome;
    readonly reason: string;
    readonly which?: (challenge: AuthorizationChallenge) => boolean;
  },
): Reduced & { readonly names: readonly string[] } {
  const closing = openAuthorizationsOf(state).filter(
    (open) => input.which === undefined || input.which(open.challenge),
  );
  if (closing.length === 0) return { events: [], names: [], state };
  const closed = new Set(closing.map((open) => attemptKey(open.challenge)));
  const names = closing.map((open) => open.challenge.name);
  return {
    events: closing.map((open) => completed(open.challenge, open.at, input.outcome, input.reason)),
    names: [...new Set(names)],
    state: {
      ...state,
      signIns: state.signIns.filter((challenge) => !closed.has(attemptKey(challenge))),
    },
  };
}

/** The attempt ids of every open authorization, whose callbacks the turn waits for. */
export function awaitedAuthorizations(state: SessionView): readonly string[] {
  return openAuthorizationsOf(state).flatMap((open) =>
    open.challenge.attemptId === undefined ? [] : [open.challenge.attemptId],
  );
}

export function openAuthorizationsOf(state: SessionView): OpenAuthorization[] {
  return state.signIns
    .filter((challenge) => challenge.candidateId === undefined)
    .map((challenge) => ({
      kind: "authorization",
      challenge,
      at: state.projection.authorizations[attemptKey(challenge)] ?? turnPosition(state.projection),
    }));
}

/** A callback names its attempt; challenges minted before attempts existed fall back. */
function attemptKey(challenge: AuthorizationChallenge): string {
  return challenge.attemptId ?? challenge.candidateId ?? challenge.name;
}

function latestPerAuthorization(
  challenges: readonly AuthorizationChallenge[],
): readonly AuthorizationChallenge[] {
  return challenges.filter(
    (candidate, index) =>
      !challenges.slice(index + 1).some((replacement) => sameAuthorization(candidate, replacement)),
  );
}

/**
 * Same scope, or the same grant from another scope, such as two tools and a
 * connection that all use one Vercel Connect connector. Responders' authorizations
 * stay per candidate because each one settles its own approval.
 */
function sameAuthorization(left: AuthorizationChallenge, right: AuthorizationChallenge): boolean {
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

/**
 * The event a workflow run reports for its own authorization, to the session that
 * relays it: `authorization.required` as the authorization opens, or
 * `authorization.completed` with its `outcome`.
 */
export function runAuthorizationEvent(
  challenge: AuthorizationChallenge,
  at: RequestAt & { readonly taskId?: string },
  outcome?: "authorized" | "failed",
) {
  const fields = { ...authorizationEventFields(challenge), ...at };
  return outcome === undefined
    ? createAuthorizationRequiredEvent({
        ...fields,
        description: `Sign in to ${challenge.name} to continue.`,
        webhookUrl: challenge.hookUrl,
      })
    : createAuthorizationCompletedEvent({ ...fields, outcome });
}

/** The `authorization.completed` an authorization publishes as it closes. */
export function completed(
  challenge: AuthorizationChallenge,
  at: RequestAt,
  outcome: AuthorizationOutcome,
  reason?: string,
): Command {
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
