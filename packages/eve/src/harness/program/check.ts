import type { ModelMessage } from "ai";

import { CompactionOverLimitError } from "#harness/compaction/over-limit-error.js";
import { COMPACTION_CHECKPOINT_MARKER } from "#harness/compaction/prompt.js";
import {
  type HarnessModelMessage,
  isUserModelMessage,
  validateHarnessModelMessages,
} from "#harness/messages.js";
import { estimateTokens } from "#harness/token-estimate.js";

/**
 * A program's history, checked before it replaces the session's: every user message keeps its
 * kind, no call loses its result, a checkpoint opens the history, and an automatic result keeps
 * the turn's input and fits.
 */
export function checkHistory(
  before: readonly HarnessModelMessage[],
  after: readonly ModelMessage[],
  input: {
    readonly automatic: boolean;
    readonly limit: number;
    /** Who returned the history, as the errors name it. */
    readonly subject?: string;
  },
): HarnessModelMessage[] {
  const subject = input.subject ?? "The session program's history";
  let messages: HarnessModelMessage[];
  try {
    messages = validateHarnessModelMessages(after);
  } catch {
    throw new Error(
      `${subject} has a user message without a kind. Keep the messages eve passed, or build a checkpoint with ctx.checkpoint().`,
    );
  }
  const was = callsAndResults(before);
  const now = callsAndResults(messages);
  for (const callId of now.calls) {
    if (!now.results.has(callId) && (was.results.has(callId) || !was.calls.has(callId))) {
      throw new Error(
        `${subject} keeps tool call ${callId} but not its result. Keep or remove a call together with its result.`,
      );
    }
  }
  for (const callId of now.results) {
    if (!now.calls.has(callId)) {
      throw new Error(
        `${subject} keeps the result of tool call ${callId} but not the call. Keep or remove a call together with its result.`,
      );
    }
  }
  const checkpoints = messages.flatMap((message, index) =>
    isCheckpointMarker(message) ? [index] : [],
  );
  if (checkpoints.some((index) => index !== 0) || checkpoints.length > 1) {
    throw new Error(`${subject} has a checkpoint after other messages. A checkpoint goes first.`);
  }
  const turnInput = before.findLast(
    (message) => isUserModelMessage(message) && message.kind === "user",
  );
  if (
    input.automatic &&
    turnInput !== undefined &&
    !messages.some((message) => JSON.stringify(message) === JSON.stringify(turnInput))
  ) {
    throw new Error(
      `${subject} drops the turn's input. Keep the latest user message: the model answers it next.`,
    );
  }
  const size = estimateTokens(messages);
  if (input.automatic && size > input.limit) {
    throw new CompactionOverLimitError(
      `${subject} is ~${Math.round(size)} tokens; the limit is ~${Math.round(input.limit)}.`,
    );
  }
  return messages;
}

/** Calls that ran here, and the results history holds. A provider-run call answers itself. */
function callsAndResults(history: readonly ModelMessage[]) {
  const calls = new Set<string>();
  const results = new Set<string>();
  for (const message of history) {
    if (typeof message.content === "string") continue;
    for (const part of message.content) {
      if (part.type === "tool-call" && part.providerExecuted !== true) calls.add(part.toolCallId);
      if (part.type === "tool-result" && message.role === "tool") results.add(part.toolCallId);
    }
  }
  return { calls, results };
}

function isCheckpointMarker(message: ModelMessage): boolean {
  return (
    isUserModelMessage(message) &&
    message.kind === "context.compaction" &&
    message.content === COMPACTION_CHECKPOINT_MARKER
  );
}
