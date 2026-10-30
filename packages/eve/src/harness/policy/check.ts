import type { ModelMessage } from "ai";

import { CompactionOverLimitError } from "#harness/compaction/over-limit-error.js";
import { COMPACTION_CHECKPOINT_MARKER } from "#harness/compaction/prompt.js";
import {
  type HarnessModelMessage,
  isUserModelMessage,
  validateHarnessModelMessages,
} from "#harness/messages.js";
import { answersFollowCalls } from "#harness/session-machine/history.js";
import { estimateTokens } from "#harness/token-estimate.js";

/**
 * A policy's history, checked before it replaces the session's: every user message has a kind,
 * every result follows its call once, no call loses its result, a checkpoint opens the history, a running turn's input stays, and
 * it fits the model's window.
 */
export function checkHistory(
  before: readonly HarnessModelMessage[],
  after: readonly ModelMessage[],
  input: {
    /** A turn is running, so its latest input must stay: the model answers it next. */
    readonly keepInput: boolean;
    /** The history's room in the call. */
    readonly limit: number;
  },
): HarnessModelMessage[] {
  let messages: HarnessModelMessage[];
  try {
    messages = validateHarnessModelMessages(after);
  } catch {
    throw new Error("The harness policy's history has a user message without a kind.");
  }
  const unsendable = answersFollowCalls(messages);
  if (unsendable !== undefined)
    throw new Error(`The harness policy's history can't be sent: ${unsendable}`);
  const was = callsAndResults(before);
  const now = callsAndResults(messages);
  for (const callId of now.calls) {
    if (!now.results.has(callId) && (was.results.has(callId) || !was.calls.has(callId))) {
      throw new Error(
        `The harness policy's history keeps tool call ${callId} but not its result. Keep or remove a call together with its result.`,
      );
    }
  }
  for (const callId of now.results) {
    if (!now.calls.has(callId)) {
      throw new Error(
        `The harness policy's history keeps the result of tool call ${callId} but not the call. Keep or remove a call together with its result.`,
      );
    }
  }
  const checkpoints = messages.flatMap((message, index) =>
    isCheckpointMarker(message) ? [index] : [],
  );
  if (checkpoints.some((index) => index !== 0) || checkpoints.length > 1) {
    throw new Error(
      "The harness policy's history has a checkpoint after other messages. A checkpoint goes first.",
    );
  }
  const turnInput = before.findLast(
    (message) => isUserModelMessage(message) && message.kind === "user",
  );
  if (
    input.keepInput &&
    turnInput !== undefined &&
    !messages.some((message) => JSON.stringify(message) === JSON.stringify(turnInput))
  ) {
    throw new Error(
      "The harness policy's history drops the turn's input. Keep the latest user message: the model answers it next.",
    );
  }
  const size = estimateTokens(messages);
  if (size > input.limit) {
    throw new CompactionOverLimitError(
      `The harness policy's history is ~${Math.round(size)} tokens; the limit is ~${Math.round(input.limit)}.`,
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
