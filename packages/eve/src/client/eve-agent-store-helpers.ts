import type { SendTurnPayload } from "#client/types.js";
import type { EveAgentReducerEvent } from "#client/reducer.js";
import { isCurrentTurnBoundaryEvent, type MessageStreamEvent } from "#protocol/message.js";
import type { UserContent } from "ai";

export function replaceProjectionEvent(
  events: readonly EveAgentReducerEvent[],
  predicate: (event: EveAgentReducerEvent) => boolean,
  replacement: EveAgentReducerEvent,
): readonly EveAgentReducerEvent[] {
  const index = events.findIndex(predicate);
  if (index === -1) return [...events, replacement];
  return [...events.slice(0, index), replacement, ...events.slice(index + 1)];
}

export function isSettledSessionTail(events: readonly MessageStreamEvent[]): boolean {
  const tail = events.at(-1);
  return (
    tail !== undefined &&
    isCurrentTurnBoundaryEvent(tail) &&
    (tail.type !== "session.waiting" || collectPendingAuthorizations(events).size === 0)
  );
}

export function collectPendingAuthorizations(events: readonly MessageStreamEvent[]): Set<string> {
  const pending = new Set<string>();
  for (const event of events) updatePendingAuthorizations(pending, event);
  return pending;
}

export function updatePendingAuthorizations(pending: Set<string>, event: MessageStreamEvent): void {
  if (event.type === "authorization.required" && event.data.webhookUrl !== undefined) {
    pending.add(event.data.name);
  } else if (event.type === "authorization.completed") {
    pending.delete(event.data.name);
  }
}

export function assertExclusiveTurnInput(input: SendTurnPayload): void {
  const hasMessage = input.message !== undefined;
  const hasResponses = input.inputResponses !== undefined;
  if (hasMessage === hasResponses) {
    throw new Error("A turn requires exactly one of message or inputResponses.");
  }
}

export function assertActiveTurnInput(input: SendTurnPayload): void {
  assertExclusiveTurnInput(input);
  if (
    input.inputResponses === undefined &&
    input.turnPolicy !== "steer" &&
    input.turnPolicy !== "interrupt"
  ) {
    throw new Error(
      'An in-flight follow-up requires input responses or a message with turnPolicy: "steer" or "interrupt".',
    );
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
