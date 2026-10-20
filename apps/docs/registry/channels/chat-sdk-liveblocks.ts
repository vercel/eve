import { createLiveblocksAdapter } from "@liveblocks/chat-sdk-adapter";
import { createMemoryState } from "@chat-adapter/state-memory";
import type { Message, Thread } from "chat";
import { chatSdkChannel, messageToUserContent } from "eve/channels/chat-sdk";

export const { bot, channel, send } = chatSdkChannel({
  userName: "My Agent",
  adapters: {
    liveblocks: createLiveblocksAdapter({
      apiKey: process.env.LIVEBLOCKS_SECRET_KEY!,
      webhookSecret: process.env.LIVEBLOCKS_WEBHOOK_SECRET!,
      botUserId: "my-agent",
      botUserName: "My Agent",
    }),
  },
  state: createMemoryState(),
  // Hand every message to eve, even mid-reply, so eve can steer the running turn.
  concurrency: "concurrent",
});

bot.onNewMention(async (thread: Thread, message: Message) => {
  await thread.subscribe();
  await send(messageToUserContent(message), { thread });
});

bot.onSubscribedMessage(async (thread: Thread, message: Message) => {
  await send(messageToUserContent(message), { thread });
});

export default channel;
