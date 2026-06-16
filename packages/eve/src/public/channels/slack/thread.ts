import type { SlackThread, SlackThreadMessage } from "#public/channels/slack/api.js";

/**
 * Boundary for {@link loadThreadContextMessages}. `"thread-root"` returns all
 * prior thread messages; `"last-agent-reply"` returns only messages after the
 * last agent-authored reply; a predicate returns only messages after the last
 * one it matches.
 */
export type ThreadContextSince =
  | "thread-root"
  | "last-agent-reply"
  | ((message: SlackThreadMessage) => boolean);

/** Options for {@link loadThreadContextMessages}. */
export interface LoadThreadContextMessagesOptions {
  /**
   * Boundary for returned context messages. Defaults to `"thread-root"`.
   *
   * Use `"last-agent-reply"` to include only user/thread messages
   * since the last agent-authored Slack reply. Pass a predicate
   * function for custom boundaries, such as "since the last message
   * that mentioned a particular user".
   */
  readonly since?: ThreadContextSince;
}

/**
 * Loads messages that are useful as background context for the current
 * Slack thread turn.
 *
 * Returns an empty array when `message` is the thread root. For thread
 * replies, refreshes the bound Slack thread and returns its recent
 * messages before the triggering message, filtered by {@link options}.
 * Formatting and model-message role choice stay with the caller.
 */
export async function loadThreadContextMessages(
  thread: Pick<SlackThread, "recentMessages" | "refresh">,
  message: {
    readonly threadTs: string;
    readonly ts: string;
  },
  options: LoadThreadContextMessagesOptions = {},
): Promise<SlackThreadMessage[]> {
  if (isThreadRootMessage(message)) {
    return [];
  }

  await thread.refresh();
  const currentIndex = thread.recentMessages.findIndex((entry) => entry.ts === message.ts);
  const candidateMessages =
    currentIndex === -1 ? thread.recentMessages : thread.recentMessages.slice(0, currentIndex);
  const priorMessages = candidateMessages.filter(
    (entry) => entry.threadTs === message.threadTs && entry.ts !== message.ts,
  );

  return applySinceBoundary(priorMessages, options.since);
}

function isThreadRootMessage(message: { readonly threadTs: string; readonly ts: string }): boolean {
  return message.threadTs === message.ts;
}

function findLastIndex<T>(items: readonly T[], predicate: (item: T) => boolean): number {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    if (predicate(items[index]!)) {
      return index;
    }
  }
  return -1;
}

function applySinceBoundary(
  messages: readonly SlackThreadMessage[],
  since: ThreadContextSince | undefined,
): SlackThreadMessage[] {
  const boundary = since ?? "thread-root";
  if (typeof boundary === "function") {
    const lastMatchingIndex = findLastIndex(messages, boundary);
    return messages.slice(lastMatchingIndex + 1);
  }

  switch (boundary) {
    case "thread-root":
      return [...messages];
    case "last-agent-reply": {
      const lastAgentReplyIndex = findLastIndex(messages, (entry) => entry.isMe);
      return messages.slice(lastAgentReplyIndex + 1);
    }
  }
}
