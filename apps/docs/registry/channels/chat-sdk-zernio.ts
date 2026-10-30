import { createZernioAdapter } from "@zernio/chat-sdk-adapter";
import { createMemoryState } from "@chat-adapter/state-memory";
import type { Message, Thread } from "chat";
import { chatSdkChannel, messageContentOf } from "eve/channels/chat-sdk";

export const { bot, channel, send } = chatSdkChannel({
  userName: "My Agent",
  adapters: {
    zernio: createZernioAdapter(),
  },
  state: createMemoryState(),
  // Hand every message to eve, even mid-reply, so eve can steer the running turn.
  concurrency: "concurrent",
});

bot.onNewMention(async (thread: Thread, message: Message) => {
  await thread.subscribe();
  await send(messageContentOf(message), { thread });
});

bot.onSubscribedMessage(async (thread: Thread, message: Message) => {
  await send(messageContentOf(message), { thread });
});

export default channel;
