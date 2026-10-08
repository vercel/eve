import type { SessionView } from "#harness/session-machine/view.js";
import { foldSession } from "#protocol/session-projection.js";
import { answerBudget, askBudget, stopBudget, withdrawBudget } from "#harness/hitl/budget-rule.js";

import {
  answerApprovals,
  cancelApprovals,
  isPolicyGated,
  openApprovals,
  steerPastApprovals,
} from "./approval.js";
import {
  checkedCandidate,
  completeCandidateAuthorization,
  expireCandidates,
  proposeCandidates,
  staleCandidates,
} from "./approval-candidate.js";
import type { Phase } from "./host.js";
import type { Input, PolicyCheck, PolicyRun } from "./input.js";
import {
  deliverToRelayed,
  endRelayedAuthorizations,
  relay,
  relayAuthorization,
  withdrawAsk,
  withdrawRelayed,
} from "./relay.js";
import {
  closeAuthorizations,
  completeAuthorization,
  requireAuthorizations,
} from "./authorization.js";
import { type Reduced } from "./state.js";
import { typedAnswers } from "./input-typed-reply.js";

// ---------------------------------------------------------------------------
// The rules: one reducer, (state, input) -> (state, events).
// ---------------------------------------------------------------------------

const STEERED_REASON = "Cancelled because a new message arrived.";
const CANCELLED_REASON = "Cancelled.";

/** A check's verdict: from the committed input, or none in a `policyChecks` dry run. */
type VerdictOf = (check: PolicyCheck) => PolicyRun | undefined;

export function verdictsOf(input: Input): VerdictOf {
  const verdicts = "verdicts" in input ? input.verdicts : undefined;
  return (check) => {
    const ran = verdicts?.[check.candidateId];
    if (ran === undefined) {
      throw new Error(
        `Human input "${input.type}" needs a verdict for candidate "${check.candidateId}": run its policyChecks first.`,
      );
    }
    return ran;
  };
}

export function reduce(
  state: SessionView,
  input: Exclude<Input, { readonly type: "actions.dispatched" | "actions.settled" }>,
  phase: Phase,
  verdictOf: VerdictOf,
): Reduced {
  switch (input.type) {
    case "policy.checked": {
      const checked = checkedCandidate(state, input.candidateId, input.verdict);
      return checked.settled === undefined
        ? checked
        : then(checked, (next) => answerApprovals(next, [checked.settled!]));
    }
    case "authorization.resumed":
      // The step installs this callback fact in its scoped tool context.
      return { events: [], state };
    case "budget.exceeded":
      return askBudget(state, input);
    case "approval.requested":
      return openApprovals(state, input);
    case "authorization.required":
      return requireAuthorizations(state, input);
    case "input.answered": {
      const budget = answerBudget(state, input.responses);
      const gated = budget.unclaimed.filter((response) =>
        isPolicyGated(budget.state, response.requestId),
      );
      const plain = budget.unclaimed.filter((response) => !gated.includes(response));
      const proposed = proposeCandidates(budget.state, { ...input, responses: gated });
      return then(
        { events: [...budget.events, ...proposed.events], state: proposed.state },
        (next) => answerApprovals(next, plain, input.responder),
        (next) => checkCandidates(next, proposed.checks, verdictOf),
      );
    }
    // A typed reply answers the budget question or approvals when it names one
    // of their options; any other message steers the turn past everything it
    // waits on.
    case "message.received": {
      const typed = typedAnswers(state, input.text, "own");
      if (typed.length === 0) return steer(state);
      const budget = answerBudget(state, typed);
      return then(
        { events: [{ type: "consumeMessage" }, ...budget.events], state: budget.state },
        (next) => answerApprovals(next, budget.unclaimed, input.sender),
      );
    }
    case "cancel.requested":
      return cancel(state, phase);
    case "relayed.requested":
      return relay(state, input);
    case "relayed.authorization":
      return relayAuthorization(state, input);
    case "turn.waiting":
      return { events: [{ type: "waitTurn" }], state };
    case "budget.stopped":
      return stopBudget(state, input.requestId);
    case "delivery.received":
      return deliverToRelayed(state, input);
    case "run.ended":
      return then(
        withdrawRelayed(state, (open) => open.route.runId === input.runId),
        (next) => endRelayedAuthorizations(next, input.runId),
      );
    case "relayed.withdrawn":
      return withdrawAsk(state, input);
    // A callback for an attempt no longer open completes nothing.
    case "authorization.completed": {
      const own = completeAuthorization(state, input);
      if (own !== undefined) return own;
      const readied = completeCandidateAuthorization(state, input);
      if (readied === undefined) return { events: [], state };
      return then(readied, (next) => checkCandidates(next, readied.checks, verdictOf));
    }
    case "time":
      return expireCandidates(state, input.now);
    case "context.cleared":
      return { events: [], state: clearedState(state) };
    case "input.resumed": {
      const queued = state.turn.queued;
      const rest = { ...state, turn: { ...state.turn, queued: undefined } };
      return queued === undefined
        ? { events: [], state }
        : { events: [{ type: "resumeInput", input: queued }], state: rest };
    }
    case "cancel.replayed":
      return carryCancel(state);
    default: {
      const unhandled: never = input;
      throw new TypeError(`Unhandled human input: ${JSON.stringify(unhandled)}`);
    }
  }
}

/**
 * The turn is cancelled. Candidates go first: their events report at their
 * approval's coordinates. The cancel stops every child and run, so nobody can
 * answer what they relayed: their requests are withdrawn where the parked host
 * can carry that out. A cancel in the turn's step closes the rest and ends the
 * turn; its relayed requests stay open until the cancelled turn settles, parked.
 */
function cancel(state: SessionView, phase: Phase): Reduced {
  if (phase !== "parked") {
    const closed = closeOwn(state);
    return {
      events: [...closed.events, { closed: "own", type: "cancelTurn" }],
      state: closed.state,
    };
  }
  return then(
    staleCandidates(state, CANCELLED_REASON),
    (next) => withdrawRelayed(next),
    (next) => closeOwn(next),
  );
}

/**
 * A cancel in the turn's step already closed and reported the turn's own
 * requests; the session the turn settles from, saved before that step,
 * closes them again without reporting them. Its held step stays, for
 * the parked settle to cancel with what the step left.
 */
function carryCancel(state: SessionView): Reduced {
  const closed = closeOwn(state);
  return { events: closed.events.filter((event) => event.type !== "publish"), state: closed.state };
}

/** Closes what the turn's own calls wait on, as cancelled: its step too, with `step`. */
function closeOwn(state: SessionView): Reduced {
  return then(
    staleCandidates(state, CANCELLED_REASON),
    (next) => endRelayedAuthorizations(next),
    withdrawBudget,
    cancelApprovals,
    (next) => closeAuthorizations(next, { outcome: "declined", reason: CANCELLED_REASON }),
  );
}

/**
 * A message that answers nothing moves the turn on: its approvals resolve,
 * their candidates go stale, and its authorizations are declined. The model hears
 * which of its authorizations ended, so it asks again only if still needed.
 */
function steer(state: SessionView): Reduced {
  const approvals = then(staleCandidates(state, STEERED_REASON), steerPastApprovals);
  const authorizations = closeAuthorizations(approvals.state, {
    outcome: "declined",
    reason: STEERED_REASON,
  });
  const events = [...approvals.events, ...authorizations.events];
  if (authorizations.names.length > 0) {
    events.push({
      text: `Sign-in to ${authorizations.names.join(", ")} was cancelled because the user sent a new message instead. Ask to sign in again only if the new message still needs it.`,
      type: "addNote",
    });
  }
  return { events, state: authorizations.state };
}

/**
 * Applies each check's verdict, in order. Allowed settles its approval with
 * the candidate's decision. A dry run has no verdicts: its candidates stay
 * pending.
 */
function checkCandidates(
  state: SessionView,
  checks: readonly PolicyCheck[],
  verdictOf: VerdictOf,
): Reduced {
  let reduced: Reduced = { events: [], state };
  for (const check of checks) {
    const ran = verdictOf(check);
    if (ran === undefined) continue;
    reduced = then(reduced, (next) => {
      const checked = checkedCandidate(next, check.candidateId, ran);
      const { settled } = checked;
      return settled === undefined ? checked : then(checked, (n) => answerApprovals(n, [settled]));
    });
  }
  return reduced;
}

/** Runs rules in order, each on the state the last one left, collecting their events. */
function then(first: Reduced, ...rest: ((state: SessionView) => Reduced)[]): Reduced {
  let state = foldReported(first);
  const events = [...first.events];
  for (const rule of rest) {
    const reduced = rule(state);
    events.push(...reduced.events);
    state = foldReported(reduced);
  }
  return { events, state };
}

/**
 * What a cleared session keeps: its standing grants, and what children and
 * runs relayed through it.
 */
function clearedState(state: SessionView): SessionView {
  return {
    ...state,
    signIns: [],
    turn: {
      ...state.turn,
      suspended: [],
      queued: undefined,
      hitl: {
        relayedRoutes: state.turn.hitl?.relayedRoutes,
        relayedAuthorizations: state.turn.hitl?.relayedAuthorizations,
      },
    },
  };
}

function foldReported(reduced: Reduced): SessionView {
  return {
    ...reduced.state,
    projection: reduced.events.reduce(
      (projection, command) =>
        command.type === "publish" ? foldSession(projection, command.event) : projection,
      reduced.state.projection,
    ),
  };
}
