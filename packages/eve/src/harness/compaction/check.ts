import type { ModelMessage } from "ai";

import { CompactionResultOverLimitError } from "#shared/compaction-over-limit-error.js";
import { isCheckpointMarker } from "#shared/compaction-checkpoint.js";
import { type HarnessModelMessage, validateHarnessModelMessages } from "#harness/messages.js";
import { answersFollowCalls } from "#harness/session-machine/history.js";
import { estimateTokens } from "#harness/token-estimate.js";

export function checkHistory(
  before: readonly HarnessModelMessage[],
  after: readonly ModelMessage[],
  input: {
    readonly limit: number;
  },
): HarnessModelMessage[] {
  const subject = "The compaction strategy's history";
  let messages: HarnessModelMessage[];
  try {
    messages = validateHarnessModelMessages(after);
  } catch {
    throw new Error(
      `${subject} has a user message without a kind. Keep the messages eve passed, and give every new user message a kind.`,
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
  const misordered = answersFollowCalls(messages);
  if (misordered !== undefined) {
    throw new Error(
      `${subject} is invalid. ${misordered} Keep or remove a call together with its result.`,
    );
  }
  if (messages.filter(isCheckpointMarker).length > 1) {
    throw new Error(`${subject} has more than one checkpoint. Keep at most one.`);
  }
  const size = estimateTokens(messages);
  if (size > input.limit) {
    throw new CompactionResultOverLimitError(
      `${subject} is ~${Math.round(size)} tokens; the limit is ~${Math.round(input.limit)}.`,
    );
  }
  return messages;
}

function callsAndResults(history: readonly ModelMessage[]) {
  const calls = new Set<string>();
  const results = new Set<string>();
  for (const message of history) {
    if (typeof message.content === "string") continue;
    for (const part of message.content) {
      if (part.type === "tool-call") calls.add(part.toolCallId);
      if (part.type === "tool-result") results.add(part.toolCallId);
    }
  }
  return { calls, results };
}
