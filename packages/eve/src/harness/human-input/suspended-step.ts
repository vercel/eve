import type { ModelMessage, ToolResultPart } from "ai";

import type { HumanInputEvent, RequestAt } from "./index.js";

// History is append-only, and a call joins it only with its result. A model
// step whose calls wait on a person is suspended: its response stays here,
// out of history, and results join it as they arrive. Once every call it made
// has a result, the whole step is appended at once.

/** A model step held out of history until every call it made has a result. */
export interface SuspendedStep {
  readonly at: RequestAt;
  /**
   * The step's response and the results it has so far. Empty while the
   * coordination batch holds the response, until its runtime calls settle.
   */
  readonly messages: readonly ModelMessage[];
}

/** The state the suspended-step rules read and change. */
export interface SuspendedStepState {
  readonly suspended?: SuspendedStep;
}

/**
 * Adds results to the step: they join its trailing tool message, so the
 * step's calls answer as one tool response.
 */
export function withResults(
  messages: readonly ModelMessage[],
  results: readonly ToolResultPart[],
): ModelMessage[] {
  if (results.length === 0) return [...messages];
  const tail = messages.at(-1);
  if (tail?.role === "tool") {
    return [...messages.slice(0, -1), { content: [...tail.content, ...results], role: "tool" }];
  }
  return [...messages, { content: [...results], role: "tool" }];
}

/**
 * The calls in `messages` without a result there. Provider-executed calls
 * carry their result in the assistant message, so they count as answered.
 */
export function unansweredCalls(
  messages: readonly ModelMessage[],
): { readonly toolCallId: string; readonly toolName: string }[] {
  const answered = new Set<string>();
  for (const message of messages) {
    if (typeof message.content === "string") continue;
    for (const part of message.content) {
      if (part.type === "tool-result") answered.add(part.toolCallId);
    }
  }
  const calls: { toolCallId: string; toolName: string }[] = [];
  for (const message of messages) {
    if (message.role !== "assistant" || typeof message.content === "string") continue;
    for (const part of message.content) {
      if (part.type !== "tool-call" || part.providerExecuted === true) continue;
      if (!answered.has(part.toolCallId)) calls.push(part);
    }
  }
  return calls;
}

/**
 * Appends the suspended step to history, with `results` joined to it, and
 * clears it. Without a suspended step (one parked before steps were held out
 * of history), `results` alone are appended after the calls already there.
 */
export function releaseStep<S extends SuspendedStepState>(
  state: S,
  results: readonly ToolResultPart[],
): { readonly events: readonly HumanInputEvent[]; readonly state: S } {
  const messages = withResults(state.suspended?.messages ?? [], results);
  const { suspended: _released, ...rest } = state;
  return {
    events: messages.map((message) => ({ message, type: "history.appended" as const })),
    state: rest as S,
  };
}

/** Adds messages to the step; tool messages join its trailing tool response. */
export function withMessages(
  messages: readonly ModelMessage[],
  more: readonly ModelMessage[],
): ModelMessage[] {
  let joined = [...messages];
  for (const message of more) {
    joined =
      message.role === "tool"
        ? withResults(
            joined,
            message.content.filter((part): part is ToolResultPart => part.type === "tool-result"),
          )
        : [...joined, message];
  }
  return joined;
}

/**
 * `messages` without these calls and their results, so the model calls them
 * again once signed in. An assistant message the calls leave with only text
 * goes too: it narrated calls that never happened.
 */
export function withoutCalls(
  messages: readonly ModelMessage[],
  callIds: ReadonlySet<string>,
): ModelMessage[] {
  return messages.flatMap((message): ModelMessage[] => {
    if (message.role === "assistant" && Array.isArray(message.content)) {
      const stopped = message.content.some(
        (part) => part.type === "tool-call" && callIds.has(part.toolCallId),
      );
      const content = message.content.filter(
        (part) => part.type !== "tool-call" || !callIds.has(part.toolCallId),
      );
      const hasOtherCall = content.some((part) => part.type === "tool-call");
      return content.length === 0 || (stopped && !hasOtherCall) ? [] : [{ ...message, content }];
    }
    if (message.role === "tool") {
      const content = message.content.filter(
        (part) => part.type !== "tool-result" || !callIds.has(part.toolCallId),
      );
      return content.length === 0 ? [] : [{ ...message, content }];
    }
    return [message];
  });
}
