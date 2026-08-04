import { createKapsoAdapter } from "@kapso/chat-adapter";
import { createMemoryState } from "@chat-adapter/state-memory";
import type { Message, Thread } from "chat";
import { chatSdkChannel } from "eve/channels/chat-sdk";

export const { bot, channel, send } = chatSdkChannel({
  userName: "My Agent",
  adapters: {
    kapso: createKapsoAdapter({
      kapsoApiKey: process.env.KAPSO_API_KEY!,
      phoneNumberId: process.env.KAPSO_PHONE_NUMBER_ID!,
      webhookSecret: process.env.KAPSO_WEBHOOK_SECRET!,
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
