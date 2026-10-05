import type { UserContent } from "ai";

import type { Message } from "#compiled/chat/index.js";
import { messageToUserContent } from "#public/channels/chat-sdk/index.js";

/** Returns model-visible Linq content, or `undefined` for blank messages. */
export async function linqInboundContent(
  message: Message,
): Promise<string | UserContent | undefined> {
  const content = await messageToUserContent(message);
  if (typeof content === "string") return content.trim().length > 0 ? content : undefined;
  return content.length > 0 ? content : undefined;
}
