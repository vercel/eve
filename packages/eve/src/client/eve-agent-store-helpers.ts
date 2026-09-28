import { conversationAuthorizations, type ConversationState } from "#client/conversation-state.js";
import type { ActiveTurn } from "#client/eve-agent-store-state.js";
import type { MessageResponse } from "#client/message-response.js";
import { isTurnSegmentBoundary, updatePendingInputRequests } from "#client/session-utils.js";
import type { CancelSessionResult, SendTurnPayload } from "#client/types.js";
import { isCurrentTurnBoundaryEvent, type MessageStreamEvent } from "#protocol/message.js";
import type { UserContent } from "ai";

export function activeTurnForOptimisticFollowUp(
  events: readonly MessageStreamEvent[],
): string | undefined {
  const lastTurn = events.findLast(
    (event) =>
      event.type === "turn.started" ||
      event.type === "turn.completed" ||
      event.type === "turn.failed" ||
      event.type === "turn.cancelled" ||
      isCurrentTurnBoundaryEvent(event),
  );
  return lastTurn?.type === "turn.started" ? lastTurn.data.turnId : undefined;
}

/**
 * Where a store operation stops reading, as `session.send().result()` does: a turn boundary
 * once no sign-in awaits its callback, or `turn.waiting` while a question awaits an answer.
 */
export function isResponseBoundary(
  event: MessageStreamEvent,
  conversation: ConversationState,
): boolean {
  if (event.type === "turn.waiting") {
    return Object.values(conversation.inputs).some((input) => input.status !== "settled");
  }
  return (
    isCurrentTurnBoundaryEvent(event) &&
    (event.type !== "session.waiting" || !hasPendingAuthorizations(conversation))
  );
}

/** A turn parked on a question stays open, so its session is still streaming. */
export function settledStatus(
  error: Error | undefined,
  conversation: ConversationState,
): "error" | "ready" | "streaming" {
  if (error !== undefined) return "error";
  return conversation.activeTurnId === undefined ? "ready" : "streaming";
}

export function isSettledSessionTail(
  events: readonly MessageStreamEvent[],
  conversation: ConversationState,
): boolean {
  const tail = events.at(-1);
  return tail !== undefined && isResponseBoundary(tail, conversation);
}

export function hasPendingAuthorizations(conversation: ConversationState): boolean {
  return conversationAuthorizations(conversation).some(
    (part) => part.state === "required" && part.awaitsCallback === true,
  );
}

/** A server ignores answers to requests it already settled, so the store never sends them. */
export function assertAnswerable(input: SendTurnPayload, conversation: ConversationState): void {
  for (const { requestId } of input.inputResponses ?? []) {
    const status = conversation.inputs[requestId]?.status;
    if (status !== undefined && status !== "open") {
      throw new Error(`Input request ${requestId} was already answered.`);
    }
  }
}

export function assertInFlightFollowUp(input: SendTurnPayload): void {
  if (input.inputResponses !== undefined) return;
  if (input.message === undefined || input.turnPolicy !== "steer") {
    throw new Error(
      'eve session is already processing a turn. Send a message with turnPolicy: "steer" to guide it at the next boundary, or answer an open input request.',
    );
  }
}

export function validateFollowUp<T extends SendTurnPayload>(input: T): T {
  assertExclusiveTurnInput(input);
  assertInFlightFollowUp(input);
  return input;
}

export function assertExclusiveTurnInput(input: SendTurnPayload): void {
  const hasMessage = input.message !== undefined;
  const hasResponses = input.inputResponses !== undefined;
  if (hasMessage === hasResponses) {
    throw new Error("A turn requires exactly one of message or inputResponses.");
  }
}

let submissionSequence = 0;

export function createSubmissionId(): string {
  const randomUUID = globalThis.crypto?.randomUUID;
  if (randomUUID !== undefined) {
    return randomUUID.call(globalThis.crypto);
  }

  submissionSequence += 1;
  return `submission_${submissionSequence.toString()}`;
}

export function createAbortSignal(
  first: AbortSignal | undefined,
  second: AbortSignal,
): AbortSignal {
  return first ? AbortSignal.any([first, second]) : second;
}

export function summarizeUserContent(message: string | UserContent): string {
  if (typeof message === "string") return message;

  const parts: string[] = [];
  for (const part of message) {
    if (part.type === "text") {
      parts.push(part.text);
    } else if (part.type === "file") {
      parts.push(part.filename ? `[file: ${part.filename}]` : "[file]");
    }
  }
  return parts.join("\n");
}

export function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

export function toTerminalStreamFailureError(event: MessageStreamEvent): Error | undefined {
  if (event.type !== "session.failed") return undefined;

  const error = new Error(event.data.message);
  error.name = event.data.code;
  return error;
}

export function createActiveTurn(
  cancel: (turn: ActiveTurn) => Promise<CancelSessionResult>,
): ActiveTurn {
  const response = Promise.withResolvers<MessageResponse | undefined>();
  const completion = Promise.withResolvers<void>();
  const turn: ActiveTurn = {
    abortController: new AbortController(),
    acceptedFollowUps: 0,
    cancel: () => cancel(turn),
    completion: completion.promise,
    followUpDispatches: new Set(),
    receivedFollowUps: 0,
    receivedFollowUpEvents: new Map(),
    followUpSubmissionIds: new Set(),
    resolveCompletion: completion.resolve,
    response: response.promise,
    resolveResponse: response.resolve,
  };
  return turn;
}

/** Counts confirmed steered messages toward the active turn's accepted follow-ups. */
export function countFollowUpDeliveries(
  turn: ActiveTurn,
  reconciliation: {
    readonly alreadyProjected: boolean;
    readonly event: MessageStreamEvent;
    readonly ids: readonly string[];
  },
): void {
  let followed = 0;
  for (const id of reconciliation.ids) {
    if (turn.followUpSubmissionIds.delete(id)) followed += 1;
  }
  if (followed === 0) return;
  if (reconciliation.alreadyProjected) {
    turn.receivedFollowUps += followed;
  } else {
    const previous = turn.receivedFollowUpEvents.get(reconciliation.event) ?? 0;
    turn.receivedFollowUpEvents.set(reconciliation.event, previous + followed);
  }
}

export async function followSteeredTurns(
  turn: ActiveTurn,
  events: AsyncIterable<MessageStreamEvent>,
  isActive: () => boolean,
): Promise<void> {
  while (turn.followUpDispatches.size > 0) {
    await Promise.allSettled(turn.followUpDispatches);
  }
  if (turn.receivedFollowUps >= turn.acceptedFollowUps) return;
  const pendingInputRequests = new Set<string>();
  for await (const event of events) {
    if (!isActive()) return;
    turn.receivedFollowUps += turn.receivedFollowUpEvents.get(event) ?? 0;
    turn.receivedFollowUpEvents.delete(event);
    updatePendingInputRequests(pendingInputRequests, event);
    if (isTurnSegmentBoundary(event, pendingInputRequests)) {
      while (turn.followUpDispatches.size > 0) {
        await Promise.allSettled(turn.followUpDispatches);
      }
      if (turn.receivedFollowUps >= turn.acceptedFollowUps) return;
    }
  }
}

/** Aborts a caller's wait without cancelling shared work owned by the store. */
export async function waitWithSignal<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (signal === undefined) return await promise;
  const aborted = Promise.withResolvers<never>();
  const onAbort = () => aborted.reject(signal.reason);
  signal.addEventListener("abort", onAbort, { once: true });
  if (signal.aborted) onAbort();
  try {
    return await Promise.race([aborted.promise, promise]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}
