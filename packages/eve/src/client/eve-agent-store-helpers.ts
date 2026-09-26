import { conversationAuthorizations, type ConversationState } from "#client/conversation-state.js";
import type { ActiveTurn } from "#client/eve-agent-store-state.js";
import type { MessageResponse } from "#client/message-response.js";
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

export function isSettledSessionTail(
  events: readonly MessageStreamEvent[],
  conversation: ConversationState,
): boolean {
  const tail = events.at(-1);
  return (
    tail !== undefined &&
    isCurrentTurnBoundaryEvent(tail) &&
    (tail.type !== "session.waiting" || !hasPendingAuthorizations(conversation))
  );
}

export function hasPendingAuthorizations(conversation: ConversationState): boolean {
  return conversationAuthorizations(conversation).some(
    (part) => part.state === "pending" || (part.state === "required" && part.awaitsCallback),
  );
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
  for await (const event of events) {
    if (!isActive()) return;
    turn.receivedFollowUps += turn.receivedFollowUpEvents.get(event) ?? 0;
    turn.receivedFollowUpEvents.delete(event);
    if (isCurrentTurnBoundaryEvent(event)) {
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
