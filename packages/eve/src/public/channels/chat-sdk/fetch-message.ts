import type { Message } from "#compiled/chat/index.js";

export interface MessageLookup {
  fetchMessage?(threadId: string, messageId: string): Promise<Message | null>;
}

const LOOKUP_TIMEOUT_MS = 3000;

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
