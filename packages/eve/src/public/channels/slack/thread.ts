import type { SlackThread, SlackThreadMessage } from "#public/channels/slack/api.js";
import type { SlackMessage } from "#public/channels/slack/inbound.js";

const COPIED_MESSAGE_UNFURL_DELAY_MS = 500;
const SLACK_MESSAGE_PERMALINK =
  /^:crosspost:\s*<https:\/\/[a-z0-9-]+(?:\.enterprise)?\.slack\.com\/archives\/[A-Z0-9]+\/p\d+(?:\?[^>]*)?(?:\|[^>]*)?>$/iu;

/**
 * Replaces a copied Slack permalink with the message unfurl Slack attaches
 * shortly after delivery. Native forwards already contain their unfurl in the
 * webhook and skip this path.
 */
export async function hydrateCopiedSlackMessage(
  thread: Pick<SlackThread, "recentMessages" | "refresh">,
  message: SlackMessage,
  wait: (milliseconds: number) => Promise<void> = delay,
): Promise<SlackMessage> {
  if (!isCopiedSlackMessagePermalink(message.text)) return message;

  await wait(COPIED_MESSAGE_UNFURL_DELAY_MS);
  await thread.refresh();

  const refreshed = thread.recentMessages.find((entry) => entry.ts === message.ts);
  if (refreshed === undefined || isCopiedSlackMessagePermalink(refreshed.text)) {
    return message;
  }

  return {
    ...message,
    text: refreshed.text,
    markdown: refreshed.markdown,
    raw: { ...message.raw, ...refreshed.raw },
  };
}

function isCopiedSlackMessagePermalink(text: string): boolean {
  const withoutLeadingMentions = text.trim().replace(/^(?:<@[^>\s]+>\s*)+/u, "");
  return SLACK_MESSAGE_PERMALINK.test(withoutLeadingMentions);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

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
 * replies, reuses already loaded thread messages or refreshes the bound
 * Slack thread, then returns messages before the triggering message,
 * filtered by {@link options}. Formatting and model-message role choice
 * stay with the caller.
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

  if (thread.recentMessages.length === 0) {
    await thread.refresh();
  }
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
