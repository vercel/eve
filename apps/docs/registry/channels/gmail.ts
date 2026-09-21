import { createGmailAdapter } from "@chat-adapter/gmail";
import { createRedisState } from "@chat-adapter/state-redis";
import type { Message, Thread } from "chat";
import { chatSdkChannel } from "eve/channels/chat-sdk";

export const gmail = createGmailAdapter();

export const { bot, channel, send } = chatSdkChannel({
  userName: "My Agent",
  adapters: { gmail },
  state: createRedisState({ keyPrefix: "gmail-agent" }),
  // Gmail sends email once and cannot edit an in-progress response.
  streaming: false,
});

bot.onNewMention(async (thread: Thread, message: Message) => {
  await thread.subscribe();
  await send(message.text, { thread });
});

bot.onSubscribedMessage(async (thread: Thread, message: Message) => {
  await send(message.text, { thread });
});

await bot.initialize();

export default channel;
