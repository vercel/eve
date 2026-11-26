import type { ModelMessage } from "ai";

import { contextStorage } from "#context/container.js";
import { HistoryStateKey } from "#context/keys.js";
import { keptAnnouncements } from "#harness/announcements.js";
import { withoutPromptMeasurement } from "#harness/compaction/engine.js";
import { validateHarnessModelMessages } from "#harness/messages.js";
import type { HarnessSession } from "#harness/types.js";
import { checksSessionEvents } from "#shared/dev-checks.js";

export type HistoryChange =
  | { readonly append: readonly ModelMessage[] }
  | { readonly extend: readonly ModelMessage[] }
  | { readonly repaired: readonly ModelMessage[] }
  | { readonly rewrite: readonly ModelMessage[] };

type WithHistory = Pick<HarnessSession, "compaction" | "history">;

export function changeHistory<T extends WithHistory>(session: T, change: HistoryChange): T {
  const changed = applyChange(session, change);
  if (changed !== session && checksSessionEvents()) assertAnswersFollowCalls(changed.history);
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
  if ("repaired" in change) {
    return { ...session, history: validateHarnessModelMessages(change.repaired) };
  }
  const history = validateHarnessModelMessages(change.rewrite);
  const ctx = contextStorage.getStore();
  const state = ctx?.get(HistoryStateKey);
  if (ctx !== undefined && state !== undefined) {
    ctx.set(HistoryStateKey, keptAnnouncements(state, history));
  }
  return {
    ...session,
    compaction: withoutPromptMeasurement(session.compaction),
    history,
  };
}

function assertKeeps(previous: readonly ModelMessage[], next: readonly ModelMessage[]): void {
  if (!checksSessionEvents()) return;
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

export function answersFollowCalls(history: readonly ModelMessage[]): string | undefined {
  const calls = new Set<string>();
  const answered = new Set<string>();
  for (const [index, message] of history.entries()) {
    if (typeof message.content === "string") continue;
    for (const part of message.content) {
      if (part.type === "tool-call") calls.add(part.toolCallId);
      if (part.type !== "tool-result") continue;
      if (!calls.has(part.toolCallId)) {
        return `History message ${index} answers tool call ${part.toolCallId}, which no earlier message made.`;
      }
      if (answered.has(part.toolCallId)) {
        return `History message ${index} answers tool call ${part.toolCallId} a second time.`;
      }
      answered.add(part.toolCallId);
    }
  }
  return undefined;
}

function assertAnswersFollowCalls(history: readonly ModelMessage[]): void {
  const problem = answersFollowCalls(history);
  if (problem !== undefined) throw new Error(problem);
}

function sameMessage(a: ModelMessage, b: ModelMessage | undefined): boolean {
  return a === b || JSON.stringify(a) === JSON.stringify(b);
}
