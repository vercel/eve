import type { UserContent } from "ai";

import type { Message } from "#compiled/chat/index.js";
import { messageToUserContent } from "#public/channels/chat-sdk/index.js";

/** Returns model-visible Sendblue content, or `undefined` for non-message events. */
export function sendblueInboundContent(message: Message): string | UserContent | undefined {
  const content = messageToUserContent(message);
  if (typeof content === "string") {
    return content.trim().length > 0 ? content : undefined;
  }
  return content.length > 0 ? content : undefined;
}
