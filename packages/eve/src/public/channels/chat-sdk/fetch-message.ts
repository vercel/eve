import type { Message } from "#compiled/chat/index.js";

/** The slice of a Chat SDK adapter that fetches one message by id. */
export interface MessageLookup {
  fetchMessage?(threadId: string, messageId: string): Promise<Message | null>;
}

// Inbound handling waits on this lookup, and some SDKs (Linq) retry for minutes.
const LOOKUP_TIMEOUT_MS = 3000;

/**
 * Fetches a message by id, or returns `null` when the adapter can't, the
 * lookup fails, or it takes longer than a few seconds.
 */
export async function fetchMessageBestEffort(
  adapter: MessageLookup,
  threadId: string,
  messageId: string,
): Promise<Message | null> {
  if (adapter.fetchMessage === undefined) return null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      adapter.fetchMessage(threadId, messageId),
      new Promise<null>((resolve) => {
        timer = setTimeout(resolve, LOOKUP_TIMEOUT_MS, null);
      }),
    ]);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
