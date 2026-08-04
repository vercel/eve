import { createZernioAdapter } from "@zernio/chat-sdk-adapter";
import { createMemoryState } from "@chat-adapter/state-memory";
import type { Message, Thread } from "chat";
import { chatSdkChannel } from "eve/channels/chat-sdk";

export const { bot, channel, send } = chatSdkChannel({
  userName: "My Agent",
  adapters: {
    zernio: createZernioAdapter(),
  },
  state: createMemoryState(),
});

bot.onNewMention(async (thread: Thread, message: Message) => {
  await thread.subscribe();
  await send({ message: message.text, thread });
});

bot.onSubscribedMessage(async (thread: Thread, message: Message) => {
  await send({ message: message.text, thread });
});

export default channel;
