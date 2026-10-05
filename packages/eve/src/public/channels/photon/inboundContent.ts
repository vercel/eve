import type { UserContent } from "ai";

import type { Message } from "#compiled/chat/index.js";
import { messageToUserContent } from "#public/channels/chat-sdk/index.js";

/** Returns model-visible Photon content, or `undefined` for non-message events. */
export async function photonInboundContent(
  message: Message,
): Promise<string | UserContent | undefined> {
  const content = await messageToUserContent(message);
  if (typeof content === "string") {
    return content.trim().length > 0 ? content : undefined;
  }
  return content.length > 0 ? content : undefined;
}
