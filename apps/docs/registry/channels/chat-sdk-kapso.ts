import { createKapsoAdapter } from "@kapso/chat-adapter";
import { createMemoryState } from "@chat-adapter/state-memory";
import type { Message, Thread } from "chat";
import { chatSdkChannel, messageContentOf } from "eve/channels/chat-sdk";

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
  // Hand every message to eve, even mid-reply, so eve can steer the running turn.
  concurrency: "concurrent",
  // WhatsApp can't edit sent messages, so send each reply whole.
  streaming: false,
});

bot.onNewMention(async (thread: Thread, message: Message) => {
  await thread.subscribe();
  await send(messageContentOf(message), { thread });
});

bot.onSubscribedMessage(async (thread: Thread, message: Message) => {
  await send(messageContentOf(message), { thread });
});

export default channel;
