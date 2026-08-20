import type { CancelSessionResult, SendTurnPayload } from "#client/types.js";
import type { MessageStreamEvent } from "#protocol/message.js";
import type { UserContent } from "ai";

export interface ActiveTurn {
  cancellation?: Promise<CancelSessionResult>;
  readonly resolveTurnId: (turnId: string | undefined) => void;
  settled: boolean;
  readonly turnId: Promise<string | undefined>;
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

export function createActiveTurn(): ActiveTurn {
  const turnId = Promise.withResolvers<string | undefined>();
  return {
    resolveTurnId: turnId.resolve,
    settled: false,
    turnId: turnId.promise,
  };
}

export function createAbortSignal(
  first: AbortSignal | undefined,
  second: AbortSignal,
): AbortSignal {
  return first ? AbortSignal.any([first, second]) : second;
}

export function summarizeUserContent(message: string | UserContent): string {
  if (typeof message === "string") {
    return message;
  }

  const parts: string[] = [];
  for (const part of message) {
    if (part.type === "text") {
      parts.push(part.text);
      continue;
    }

    if (part.type === "file") {
      parts.push(part.filename ? `[file: ${part.filename}]` : "[file]");
    }
  }

  return parts.join("\n");
}

export function isAbortError(error: Error): boolean {
  return error.name === "AbortError";
}

export function toTerminalStreamFailureError(event: MessageStreamEvent): Error | undefined {
  if (event.type !== "session.failed") {
    return undefined;
  }

  const error = new Error(event.data.message);
  error.name = event.data.code;
  return error;
}
