import { createDialAdapter } from "@getdial/chat-sdk-adapter";
import { createMemoryState } from "@chat-adapter/state-memory";
import type { Message, Thread } from "chat";
import { chatSdkChannel } from "eve/channels/chat-sdk";

export const { bot, channel, send } = chatSdkChannel({
  userName: "My Agent",
  adapters: {
    dial: createDialAdapter({
      apiKey: process.env.DIAL_API_KEY!,
      fromNumberId: process.env.DIAL_FROM_NUMBER_ID!,
      webhookSecret: process.env.DIAL_WEBHOOK_SECRET!,
    }),
  },
  state: createMemoryState(),
});

bot.onNewMention(async (thread: Thread, message: Message) => {
  await thread.subscribe();
  await send(message.text, { thread });
});

bot.onSubscribedMessage(async (thread: Thread, message: Message) => {
  await send(message.text, { thread });
});

export default channel;
