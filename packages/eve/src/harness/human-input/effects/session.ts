import type { ModelMessage } from "ai";

import type { DeliverHookPayload, DeliverPayload } from "#channel/types.js";
import { hasDelegatedSessionContext } from "#execution/delegated-session-context.js";
import {
  readDurableSession,
  replaceDurableSessionSnapshot,
  type DurableSessionState,
} from "#execution/durable-session-store.js";
import {
  relaySessionEvents,
  type PublishedSessionEvents,
  type SessionStepState,
} from "#execution/publish-session-events.js";
import { getHarnessEmissionState } from "#harness/emission.js";
import {
  HumanInput,
  type HumanInputEvent,
  type Intake,
  type RelayRoute,
} from "#harness/human-input/index.js";
import { getSessionUsage } from "#harness/turn-tag-state.js";
import type { HandleEventFn, HarnessSessionBase } from "#harness/types.js";
import { inputTextKey, readAnswerText } from "#internal/input-text.js";
import { createTurnWaitingEvent, type UnstampedMessageStreamEvent } from "#protocol/message.js";
import type { InputResponse } from "#shared/input.js";

import { forwardAnswers, withdrawQuestion, type Forward } from "./asker.js";
import { deliverChannelInputResponses } from "./channel-answer-ids.js";

/** How human input ended the turn, for the session workflow to carry out. */
export type HumanInputEnding = { readonly kind: "cancelled" };

/**
 * Applies what human input reported to a session step outside the harness:
 * a cancel, or a request a workflow run relays or withdraws. Each event has
 * one meaning here. Returns how the turn ended, when an event ended it, which
 * the session workflow carries out once the step commits, and the messages
 * history gains. `session` is the session the step publishes for, which a
 * held turn's `turn.waiting` reports on.
 */
export async function applyHumanInputEvents(
  emit: HandleEventFn,
  events: readonly HumanInputEvent[],
  session?: HarnessSessionBase,
): Promise<{ readonly ending?: HumanInputEnding; readonly history: readonly ModelMessage[] }> {
  let ending: HumanInputEnding | undefined;
  const history: ModelMessage[] = [];
  for (const event of events) {
    switch (event.type) {
      case "publish":
        await emit(event.event);
        continue;
      case "history.appended":
        history.push(event.message);
        continue;
      case "turn.cancelled":
        ending ??= { kind: "cancelled" };
        continue;
      case "turn.held": {
        if (session === undefined) throw new Error("A held turn needs the session it holds.");
        const turn = getHarnessEmissionState(session.state);
        await emit(
          createTurnWaitingEvent({
            on: "input",
            sequence: turn.sequence,
            turnId: turn.turnId,
            usage: getSessionUsage(session),
          }),
        );
        continue;
      }
      case "question.withdrawn":
        await withdrawQuestion(event.control, event.requestId);
        continue;
      case "note":
      case "message.answered":
      case "calls.approved":
      case "calls.dispatched":
      case "sign-in.completed":
      case "responder.check":
      case "answer.forwarded":
      case "budget.granted":
      case "budget.declined":
        throw new Error(`Human input event "${event.type}" is not implemented.`);
    }
  }
  return { ending, history };
}

/**
 * Publishes, as relayed, what human input reported for requests this session
 * relays: withdrawals once nobody can answer them, and a run's withdrawn
 * question. The step writes the state that goes with them.
 */
export async function relayHumanInputEvents(
  target: SessionStepState,
  events: readonly HumanInputEvent[],
): Promise<PublishedSessionEvents> {
  const published: UnstampedMessageStreamEvent[] = [];
  for (const event of events) {
    if (event.type === "publish") published.push(event.event);
    else if (event.type === "question.withdrawn") await applyHumanInputEvents(emitNothing, [event]);
    else throw new Error(`Human input event "${event.type}" is not a relayed withdrawal.`);
  }
  return await relaySessionEvents(target, published);
}

async function emitNothing(): Promise<void> {}

/** Splits a transition's events into those of exchanges the session relays and its own. */
export function partitionRelayed(events: readonly HumanInputEvent[]): {
  readonly own: readonly HumanInputEvent[];
  readonly relayed: readonly HumanInputEvent[];
} {
  const relayed = events.filter((event) => event.type === "publish" && event.relayed === true);
  return { own: events.filter((event) => !relayed.includes(event)), relayed };
}

/**
 * Reports to human input that a run ended or asks to withdraw its question,
 * and relays the withdrawals it reports.
 */
export async function withdrawRelayedRequests(
  target: SessionStepState & {
    readonly intake: Extract<Intake, { readonly type: "run.ended" | "withdraw.requested" }>;
  },
): Promise<PublishedSessionEvents> {
  const session = readDurableSession(target.sessionState);
  const transition = HumanInput.read(session.state).intake(target.intake);
  return await relayHumanInputEvents(
    {
      ...target,
      sessionState: replaceDurableSessionSnapshot({
        session: { ...session, state: transition.humanInput.write(session.state) },
        state: target.sessionState,
      }),
    },
    transition.events,
  );
}

export type ForwardedRelayedAnswers =
  | {
      readonly kind: "cancel-turn";
      readonly serializedContext: Record<string, unknown>;
      readonly sessionState: DurableSessionState;
    }
  | {
      readonly kind: "continue";
      /** What the delivery leaves for this session's turn, or `undefined` when nothing. */
      readonly remainder: DeliverHookPayload | undefined;
      readonly serializedContext: Record<string, unknown>;
      readonly sessionState: DurableSessionState;
    };

/** Payload keys that describe the message, dropped with it when it answers a question. */
const MESSAGE_KEYS: ReadonlySet<string> = new Set(["context", "message", inputTextKey]);

/**
 * Reports a delivery to human input, payload by payload, forwards the answers
 * it hands to relayed requests to whoever asked, and relays the events it
 * reports once they are on their way. Returns what is left for this session's
 * turn, or `cancel-turn` when an answer cancelled it.
 */
export async function forwardRelayedAnswers(
  input: SessionStepState & { readonly delivery: DeliverHookPayload },
): Promise<ForwardedRelayedAnswers> {
  const session = readDurableSession(input.sessionState);
  let humanInput = HumanInput.read(session.state);
  const relayed = humanInput.relayedRequestIds();
  const { delivery, serializedContext } = await deliverChannelInputResponses({
    ...input,
    routable: (response) => relayed.has(response.requestId),
  });
  const delegated = hasDelegatedSessionContext(serializedContext) || delivery.caller !== undefined;

  const forwards = new Map<string, Forward>();
  const published: UnstampedMessageStreamEvent[] = [];
  const kept: [index: number, payload: DeliverPayload][] = [];
  let cancelled = false;
  for (const [index, payload] of delivery.payloads.entries()) {
    const text = readAnswerText(payload);
    const transition = humanInput.intake({
      responses: payload.inputResponses ?? [],
      ...(text !== undefined && { message: { delegated, text } }),
      type: "delivered",
    });
    humanInput = transition.humanInput;
    const forwarded = new Set<string>();
    let messageAnswered = false;
    let first: Forward | undefined;
    for (const event of transition.events) {
      switch (event.type) {
        case "answer.forwarded": {
          const key = routeKey(event.route);
          const forward = forwards.get(key) ?? { metadata: [], payloads: [], route: event.route };
          forwards.set(key, forward);
          forward.payloads.push({ inputResponses: event.responses });
          for (const response of event.responses) forwarded.add(response.requestId);
          first ??= forward;
          continue;
        }
        case "publish":
          published.push(event.event);
          continue;
        case "message.answered":
          messageAnswered = true;
          continue;
        case "turn.cancelled":
          cancelled = true;
          continue;
        default:
          throw new Error(`Human input event "${event.type}" does not follow a delivery.`);
      }
    }
    const remainder = remainderOf(payload, forwarded, messageAnswered);
    if (remainder !== undefined) {
      kept.push([index, remainder]);
      continue;
    }
    // A payload answered in full belongs to its first asker, which acknowledges it.
    for (const metadata of delivery.deliveryMetadata ?? []) {
      if (metadata.payloadIndex === index && first !== undefined) {
        first.metadata.push({ ...metadata, payloadIndex: first.payloads.length - 1 });
      }
    }
  }

  for (const forward of forwards.values()) {
    await forwardAnswers(forward, delivery, serializedContext);
  }

  const context = await relaySessionEvents(
    {
      serializedContext,
      sessionState: replaceDurableSessionSnapshot({
        session: { ...session, state: humanInput.write(session.state) },
        state: input.sessionState,
      }),
      sessionWritable: input.sessionWritable,
    },
    published,
  );
  if (cancelled) return { ...context, kind: "cancel-turn" };
  const metadata = kept.flatMap(([index], payloadIndex) =>
    (delivery.deliveryMetadata ?? [])
      .filter((entry) => entry.payloadIndex === index)
      .map((entry) => ({ ...entry, payloadIndex })),
  );
  const remainder =
    kept.length === 0
      ? undefined
      : {
          ...delivery,
          deliveryMetadata: metadata.length === 0 ? undefined : metadata,
          payloads: kept.map(([, payload]) => payload),
        };
  return { ...context, kind: "continue", remainder };
}

/**
 * Maps the channel-specific answers of a delivery to the requests a held turn
 * waits on, so the turn can tell they answer it. Returns the mapped delivery,
 * or `undefined` when the channel maps none of them to one of `requestIds`.
 */
export async function mapHeldInputResponses(
  input: SessionStepState & {
    readonly delivery: DeliverHookPayload;
    readonly requestIds: readonly string[];
  },
): Promise<{
  readonly delivery: DeliverHookPayload | undefined;
  readonly serializedContext?: Record<string, unknown>;
}> {
  const requestIds = new Set(input.requestIds);
  const mapped = await deliverChannelInputResponses({
    ...input,
    routable: (response) => requestIds.has(response.requestId),
  });
  return mapped.delivery === input.delivery
    ? { delivery: undefined }
    : { delivery: mapped.delivery, serializedContext: mapped.serializedContext };
}

/**
 * The payload without what went to askers, or `undefined` when nothing is
 * left. Channels attach context to each message, such as Telegram's sender
 * block; kept without its message, it would reach the model as one of its own.
 */
function remainderOf(
  payload: DeliverPayload,
  forwarded: ReadonlySet<string>,
  messageAnswered: boolean,
): DeliverPayload | undefined {
  const remainder: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(payload)) {
    if (key === "inputResponses" || value === undefined) continue;
    if (messageAnswered && MESSAGE_KEYS.has(key)) continue;
    remainder[key] = value;
  }
  const responses: InputResponse[] = (payload.inputResponses ?? []).filter(
    (response) => !forwarded.has(response.requestId),
  );
  if (responses.length > 0) remainder.inputResponses = responses;
  return Object.keys(remainder).length > 0 ? (remainder as DeliverPayload) : undefined;
}

function routeKey(route: RelayRoute): string {
  return JSON.stringify([
    route.childContinuationToken,
    route.childSessionInbox?.sessionId ?? null,
    route.remote?.sessionId ?? null,
    route.control ?? null,
    route.inputSource ?? null,
  ]);
}
