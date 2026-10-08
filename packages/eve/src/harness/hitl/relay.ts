import type { SessionView } from "#harness/session-machine/view.js";
/**
 * Relayed requests: questions and approvals a child session, a remote agent,
 * or a workflow run's `ctx.ask()` asks a person through this session. The call
 * that asked keeps running, so the turn waits on that call rather than on
 * a person; the session only carries the exchange. It announces each child
 * batch at the child's coordinates, forwards the answers to whoever asked, and
 * withdraws what nobody can answer anymore.
 */
import { SESSION_LIMIT_STOP_OPTION_ID } from "#harness/hitl/budget-question.js";
import {
  createInputRequestedEvent,
  createInputResolvedEvent,
  type InputResolution,
} from "#protocol/message.js";
import type { InputResponse } from "#shared/input.js";

import { outcomeOf } from "./approval.js";
import type { Command } from "./command.js";
import type { Input, RelayRoute } from "./input.js";
import { type Reduced, type OpenRelayed } from "./record.js";
import { typedAnswers } from "./input-typed-reply.js";

/**
 * A child or run asks. Its fresh batch replaces the one it asked before from
 * the same source, whose requests still open are withdrawn, and the turn
 * waits on the call that asked.
 */
export function relay(
  state: SessionView,
  input: Extract<Input, { readonly type: "relayed.requested" }>,
): Reduced {
  const { at, requests, route } = input;
  const fresh = new Set(requests.map((request) => request.requestId));
  const replaced = openRelayed(state).filter(
    (open) => sameSource(open.route, route) && !fresh.has(open.request.requestId),
  );
  const base = without(state, replaced);
  const relayedRoutes = { ...base.turn.hitl?.relayedRoutes };
  for (const request of requests) relayedRoutes[request.requestId] = route;
  return {
    events: [
      ...withdrawn(replaced),
      relayed(
        createInputRequestedEvent({
          ...at,
          callId: input.callId,
          requests,
          ...(input.taskId !== undefined && { taskId: input.taskId }),
        }),
      ),
      { relayed: true, type: "waitTurn" },
    ],
    state: { ...base, turn: { ...base.turn, hitl: { ...base.turn.hitl, relayedRoutes } } },
  };
}

/**
 * A delivery reached the session while relayed requests wait. Each answer to
 * one goes to whoever asked, in the order given; the first answer to a request
 * wins, and a request closes once answered, so a later answer is the turn's
 * again. A batch
 * resolves as its child does: without approvals, any answer closes the rest
 * as ignored; with approvals, once every approval is answered.
 *
 * A plain-text message answers a relayed question when it is the only one
 * waiting, whatever else is open, but only a person's own message with no
 * explicit answers: a delegating caller or a client that chose what to answer
 * meant something else. A relayed budget Stop also cancels this turn.
 */
export function deliverToRelayed(
  state: SessionView,
  input: Extract<Input, { readonly type: "delivery.received" }>,
): Reduced {
  const { message } = input;
  const typed =
    input.responses.length > 0 || message === undefined || message.delegated
      ? undefined
      : typedAnswers(state, message.text, "relayed")[0];
  const responses = typed === undefined ? input.responses : [typed];

  const answers = new Map<string, InputResponse>();
  for (const response of responses) {
    if (
      openRelayed(state).some((open) => open.request.requestId === response.requestId) &&
      !answers.has(response.requestId)
    ) {
      answers.set(response.requestId, response);
    }
  }
  if (answers.size === 0) return { events: [], state };

  const batches = new Map<string, OpenRelayed[]>();
  for (const requestId of answers.keys()) {
    const open = openRelayed(state).find((open) => open.request.requestId === requestId)!;
    const key = batchKey(open);
    if (!batches.has(key))
      batches.set(
        key,
        openRelayed(state).filter((o) => batchKey(o) === key),
      );
  }

  const events: Command[] = typed === undefined ? [] : [{ type: "consumeMessage" }];
  let next = state;
  let stopped = false;
  for (const members of batches.values()) {
    const answered = members.filter((open) => answers.has(open.request.requestId));
    const completes = members
      .filter((open) => open.request.kind === "tool-approval")
      .every((open) => answers.has(open.request.requestId));
    const retired = completes ? members : answered;
    events.push({
      responses: [...answers.values()].filter((response) =>
        answered.some((open) => open.request.requestId === response.requestId),
      ),
      route: members[0]!.route,
      type: "forwardAnswer",
    });
    events.push(
      relayed(
        createInputResolvedEvent({
          ...members[0]!.at,
          resolutions: retired.map((open) => resolution(open, answers.get(open.request.requestId))),
        }),
      ),
    );
    next = without(next, retired);
    stopped ||= answered.some(
      (open) =>
        open.request.kind === "session-limit" &&
        answers.get(open.request.requestId)?.optionId === SESSION_LIMIT_STOP_OPTION_ID,
    );
  }
  if (stopped) events.push({ type: "cancelTurn" });
  return { events, state: next };
}

/**
 * A child or run authorizes, or reports its responders' approval candidates.
 * The session publishes the event as relayed and records the authorization until
 * its completion arrives the same way; the turn waits on the call that asked.
 */
export function relayAuthorization(
  state: SessionView,
  input: Extract<Input, { readonly type: "relayed.authorization" }>,
): Reduced {
  const { event, runId } = input;
  const published = relayed(event);
  if (event.type === "authorization.required") {
    const { attemptId, name, sequence, stepIndex, turnId } = event.data;
    const next =
      attemptId === undefined
        ? state
        : {
            ...state,
            turn: {
              ...state.turn,
              hitl: {
                ...state.turn.hitl,
                relayedAuthorizations: {
                  ...state.turn.hitl?.relayedAuthorizations,
                  [attemptId]: { at: { sequence, stepIndex, turnId }, name, runId },
                },
              },
            },
          };
    return { events: [published, { relayed: true, type: "waitTurn" }], state: next };
  }
  if (event.type === "authorization.completed" && event.data.attemptId !== undefined) {
    return { events: [published], state: withoutAuthorizations(state, [event.data.attemptId]) };
  }
  return { events: [published], state };
}

/** A run ended, or the turn was cancelled: nobody can answer what it relayed. */
export function withdrawRelayed(
  state: SessionView,
  select: (open: OpenRelayed) => boolean = () => true,
): Reduced {
  const selected = openRelayed(state).filter(select);
  return { events: withdrawn(selected), state: without(state, selected) };
}

/**
 * The authorizations a run started end with it, or all of them with the turn. Its
 * child reports its own completion, so ending them reports nothing.
 */
export function endRelayedAuthorizations(state: SessionView, runId?: string): Reduced {
  const ended = Object.entries(state.turn.hitl?.relayedAuthorizations ?? {})
    .filter(([, authorization]) => runId === undefined || authorization.runId === runId)
    .map(([attemptId]) => attemptId);
  return { events: [], state: withoutAuthorizations(state, ended) };
}

function withoutAuthorizations(state: SessionView, attemptIds: readonly string[]): SessionView {
  if (attemptIds.length === 0 || state.turn.hitl?.relayedAuthorizations === undefined) return state;
  const ids = new Set(attemptIds);
  const remaining = Object.fromEntries(
    Object.entries(state.turn.hitl.relayedAuthorizations).filter(
      ([attemptId]) => !ids.has(attemptId),
    ),
  );
  return {
    ...state,
    turn: { ...state.turn, hitl: { ...state.turn.hitl, relayedAuthorizations: remaining } },
  };
}

/**
 * A run asks to withdraw its `ctx.ask()` question. The run hears `withdrawn`
 * either way, after any answer the session already sent it, so the question
 * resolves from the session's first decision; a question still open closes.
 */
export function withdrawAsk(
  state: SessionView,
  input: Extract<Input, { readonly type: "relayed.withdrawn" }>,
): Reduced {
  const withdrawal = withdrawRelayed(
    state,
    (open) =>
      open.request.requestId === input.requestId &&
      open.route.runId === input.runId &&
      open.route.control !== undefined,
  );
  return {
    events: [
      { control: input.control, requestId: input.requestId, type: "withdrawQuestion" },
      ...withdrawal.events,
    ],
    state: withdrawal.state,
  };
}

export function relayedRequestIds(state: SessionView): ReadonlySet<string> {
  return new Set(openRelayed(state).map((open) => open.request.requestId));
}

/** One `input.resolved` per child batch, each request `cancelled`. */
function withdrawn(requests: readonly OpenRelayed[]): Command[] {
  const batches = new Map<string, OpenRelayed[]>();
  for (const open of requests) {
    const key = batchKey(open);
    batches.set(key, [...(batches.get(key) ?? []), open]);
  }
  return [...batches.values()].map((members) =>
    relayed(
      createInputResolvedEvent({
        ...members[0]!.at,
        resolutions: members.map((open) => ({
          kind: open.request.kind,
          outcome: "cancelled",
          requestId: open.request.requestId,
        })),
      }),
    ),
  );
}

function resolution(open: OpenRelayed, response: InputResponse | undefined): InputResolution {
  const { kind, requestId } = open.request;
  const outcome =
    kind === "tool-approval"
      ? outcomeOf(response)
      : response === undefined
        ? "ignored"
        : "answered";
  return { kind, outcome, requestId, ...(response !== undefined && { response }) };
}

/** A child asks one batch at a time from each source, so its source and coordinates name it. */
function batchKey(open: OpenRelayed): string {
  const { at } = open;
  return JSON.stringify([sourceKey(open.route), at.turnId, at.sequence, at.stepIndex]);
}

function sameSource(a: RelayRoute, b: RelayRoute): boolean {
  return sourceKey(a) === sourceKey(b);
}

/** Children can share a continuation alias, so their own inbox and remote session tell them apart. */
function sourceKey(route: RelayRoute): string {
  return JSON.stringify([
    route.childContinuationToken,
    route.childSessionInbox?.sessionId ?? null,
    route.remote?.sessionId ?? null,
    route.inputSource ?? null,
  ]);
}

export function openRelayed(state: SessionView): OpenRelayed[] {
  return Object.values(state.projection.inputs).flatMap((input) => {
    const route = state.turn.hitl?.relayedRoutes?.[input.request.requestId];
    return input.status === "settled" || route === undefined
      ? []
      : [{ kind: "relayed" as const, at: input, request: input.request, route }];
  });
}

function without(state: SessionView, retired: readonly OpenRelayed[]): SessionView {
  if (retired.length === 0) return state;
  const ids = new Set(retired.map((open) => open.request.requestId));
  return {
    ...state,
    turn: {
      ...state.turn,
      hitl: {
        ...state.turn.hitl,
        relayedRoutes: Object.fromEntries(
          Object.entries(state.turn.hitl?.relayedRoutes ?? {}).filter(([id]) => !ids.has(id)),
        ),
      },
    },
  };
}

function relayed(event: Extract<Command, { type: "publish" }>["event"]): Command {
  return { event, relayed: true, type: "publish" };
}
