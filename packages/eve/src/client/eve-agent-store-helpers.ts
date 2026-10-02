import { hasPendingAuthorizations, type ConversationState } from "#client/conversation-state.js";
import type { ActiveTurn } from "#client/eve-agent-store-state.js";
import type { MessageResponse } from "#client/message-response.js";
import { endsTurnSegment, processedDeliveryIds } from "#client/session-utils.js";
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
 * Where catch-up stops following and when an idle session counts as settled. These reads have no
 * response to scope them, so the {@link endsTurnSegment} rule reads the whole conversation.
 */
export function isResponseBoundary(
  event: MessageStreamEvent,
  conversation: ConversationState,
): boolean {
  return endsTurnSegment(event, {
    callbacks: hasPendingAuthorizations(conversation),
    requests: Object.values(conversation.inputs).some((input) => input.status !== "settled"),
  });
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
    cancel: () => cancel(turn),
    completion: completion.promise,
    followUpDispatches: new Set(),
    followUps: new Set(),
    resolveCompletion: completion.resolve,
    response: response.promise,
    resolveResponse: response.resolve,
    steered: false,
  };
  return turn;
}

/** Follows the session past the turn's end until a boundary processed every steered message. */
export async function followSteeredTurns(
  turn: ActiveTurn,
  events: AsyncIterable<MessageStreamEvent>,
  isActive: () => boolean,
): Promise<void> {
  const processed = async () => {
    while (turn.followUpDispatches.size > 0) {
      await Promise.allSettled(turn.followUpDispatches);
    }
    return turn.followUps.size === 0;
  };
  if (await processed()) return;
  for await (const event of events) {
    if (!isActive()) return;
    if (!settleFollowUps(turn, event)) continue;
    if (await processed()) return;
  }
}

/**
 * Takes the steered messages a boundary processed off the turn's follow-ups, and returns whether
 * `event` is a boundary. An older writer's `session.waiting`, which lists none, processes them all.
 */
export function settleFollowUps(turn: ActiveTurn, event: MessageStreamEvent): boolean {
  const ids = processedDeliveryIds(event);
  if (ids !== undefined) {
    for (const id of ids) turn.followUps.delete(id);
    return true;
  }
  if (event.type !== "session.waiting") return false;
  turn.followUps.clear();
  return true;
}

/** Whether a boundary in `events` already processed `deliveryId`. */
export function isDeliveryProcessed(
  events: readonly MessageStreamEvent[],
  deliveryId: string,
): boolean {
  let received = false;
  for (const event of events) {
    received ||= event.meta.deliveryIds?.includes(deliveryId) === true;
    const ids = processedDeliveryIds(event);
    if (ids?.includes(deliveryId)) return true;
    // An older writer's boundary processes every delivery received before it.
    if (ids === undefined && event.type === "session.waiting" && received) return true;
  }
  return false;
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
