import { createDialAdapter } from "@getdial/chat-sdk-adapter";
import { createMemoryState } from "@chat-adapter/state-memory";
import type { Message, Thread } from "chat";
import { chatSdkChannel, messageContentOf } from "eve/channels/chat-sdk";

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
  // Hand every message to eve, even mid-reply, so eve can steer the running turn.
  concurrency: "concurrent",
  // Text messages can't be edited after they're sent, so send each reply whole.
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
