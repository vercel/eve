import { createGmailAdapter } from "@chat-adapter/gmail";
import { createRedisState } from "@chat-adapter/state-redis";
import type { Message, Thread } from "chat";
import { chatSdkChannel, messageToUserContent } from "eve/channels/chat-sdk";

export const gmail = createGmailAdapter();

export const { bot, channel, send } = chatSdkChannel({
  userName: "My Agent",
  adapters: { gmail },
  state: createRedisState({ keyPrefix: "gmail-agent" }),
  // Hand every message to eve, even mid-reply, so eve can steer the running turn.
  concurrency: "concurrent",
  // Gmail sends email once and cannot edit an in-progress response.
  streaming: false,
});

bot.onNewMention(async (thread: Thread, message: Message) => {
  await thread.subscribe();
  await send(messageToUserContent(message), { thread });
});

bot.onSubscribedMessage(async (thread: Thread, message: Message) => {
  await send(messageToUserContent(message), { thread });
});

await bot.initialize();

export default channel;
