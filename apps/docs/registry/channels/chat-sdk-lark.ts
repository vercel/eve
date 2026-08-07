import { createLarkAdapter } from "@larksuite/vercel-chat-adapter";
import { createMemoryState } from "@chat-adapter/state-memory";
import type { Message, Thread } from "chat";
import { chatSdkChannel } from "eve/channels/chat-sdk";

export const { bot, channel } = chatSdkChannel({
  userName: "My Agent",
  adapters: {
    lark: createLarkAdapter(),
  },
  state: createMemoryState(),
});

bot.onNewMention(async (thread: Thread, message: Message) => {
  await thread.subscribe();
  await thread.post({ markdown: message.text });
});

bot.onSubscribedMessage(async (thread: Thread, message: Message) => {
  await thread.post({ markdown: message.text });
});

await bot.initialize();

export default channel;
