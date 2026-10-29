import type { ModelMessage } from "ai";

import { contextStorage } from "#context/container.js";
import { HistoryStateKey } from "#context/keys.js";
import { withoutPromptMeasurement } from "#harness/compaction/engine.js";
import { validateHarnessModelMessages } from "#harness/messages.js";
import type { HarnessSession } from "#harness/types.js";

/**
 * How a step changes the conversation history. History only gains messages, except where a
 * repair or a rewrite says otherwise.
 */
export type HistoryChange =
  /** Messages join the end. */
  | { readonly append: readonly ModelMessage[] }
  /**
   * History becomes `messages`, which keep every message it held, in order: the step's prompt and
   * response, with the announcements its request placed ahead of the turn's input.
   */
  | { readonly extend: readonly ModelMessage[] }
  /** Tool exchanges a crash left unanswered gain their results; everything else stays. */
  | { readonly repaired: readonly ModelMessage[] }
  /**
   * History becomes `messages`, which keep every message the model has read (what eve last
   * measured it sending), and may change the ones it hasn't. That measurement still applies.
   */
  | { readonly unread: readonly ModelMessage[] }
  /**
   * History is replaced, as a compaction or a clear replaces it. What eve measured about the old
   * history, and the announcements it held, no longer apply.
   */
  | { readonly rewrite: readonly ModelMessage[] };

type WithHistory = Pick<HarnessSession, "compaction" | "history">;

/** The one way a session's history changes. Every message is checked as it joins. */
export function changeHistory<T extends WithHistory>(session: T, change: HistoryChange): T {
  const changed = applyChange(session, change);
  if (changed !== session && checksHistory()) assertAnswersFollowCalls(changed.history);
  return changed;
}

function applyChange<T extends WithHistory>(session: T, change: HistoryChange): T {
  if ("append" in change) {
    if (change.append.length === 0) return session;
    return {
      ...session,
      history: validateHarnessModelMessages([...session.history, ...change.append]),
    };
  }
  if ("extend" in change) {
    const history = validateHarnessModelMessages(change.extend);
    assertKeeps(session.history, history);
    return { ...session, history };
  }
  if ("unread" in change) {
    const history = validateHarnessModelMessages(change.unread);
    assertKeepsRead(session, history);
    return { ...session, history };
  }
  if ("repaired" in change) {
    return { ...session, history: validateHarnessModelMessages(change.repaired) };
  }
  // The announcements a request made, and its measured prompt, described the old history.
  contextStorage.getStore()?.delete(HistoryStateKey);
  return {
    ...session,
    compaction: withoutPromptMeasurement(session.compaction),
    history: validateHarnessModelMessages(change.rewrite),
  };
}

/**
 * Under `eve dev` and in tests, an extension that drops or changes a message history held fails:
 * it is a rewrite that kept stale measurements and announcements.
 */
function assertKeeps(previous: readonly ModelMessage[], next: readonly ModelMessage[]): void {
  if (!checksHistory()) return;
  let at = 0;
  for (const [index, message] of previous.entries()) {
    while (at < next.length && !sameMessage(message, next[at])) at += 1;
    if (at === next.length) {
      throw new Error(
        `History was extended from ${previous.length} to ${next.length} messages without message ${index} (${message.role}). A change to earlier messages is a rewrite: use changeHistory(session, { rewrite }).`,
      );
    }
    at += 1;
  }
}

/** Under `eve dev` and in tests, an unread change keeps what the model has read as it was. */
function assertKeepsRead(session: WithHistory, next: readonly ModelMessage[]): void {
  if (!checksHistory()) return;
  const read = session.compaction.lastKnownPromptMessageCount ?? session.history.length;
  for (let index = 0; index < Math.min(read, session.history.length); index += 1) {
    if (!sameMessage(session.history[index]!, next[index])) {
      throw new Error(
        `History changed message ${index}, which the model has read, without a rewrite. A change to what the model has read is a rewrite: use changeHistory(session, { rewrite }).`,
      );
    }
  }
}

/**
 * Under `eve dev` and in tests, every tool result answers a call made earlier in history, once.
 * A provider rejects a result without its call, so history that holds one can't be sent.
 */
function assertAnswersFollowCalls(history: readonly ModelMessage[]): void {
  const calls = new Set<string>();
  const answered = new Set<string>();
  for (const [index, message] of history.entries()) {
    if (typeof message.content === "string") continue;
    for (const part of message.content) {
      if (part.type === "tool-call") calls.add(part.toolCallId);
      if (part.type !== "tool-result" || message.role !== "tool") continue;
      if (!calls.has(part.toolCallId)) {
        throw new Error(
          `History message ${index} answers tool call ${part.toolCallId}, which no earlier message made.`,
        );
      }
      if (answered.has(part.toolCallId)) {
        throw new Error(
          `History message ${index} answers tool call ${part.toolCallId} a second time.`,
        );
      }
      answered.add(part.toolCallId);
    }
  }
}

function sameMessage(a: ModelMessage, b: ModelMessage | undefined): boolean {
  return a === b || JSON.stringify(a) === JSON.stringify(b);
}

export function checksHistory(): boolean {
  const configured = process.env.EVE_CHECK_SESSION_EVENTS;
  if (configured === "1") return true;
  if (configured === "0") return false;
  return process.env.EVE_DEV === "1";
}
