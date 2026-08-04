import { createMatrixAdapter } from "@beeper/chat-adapter-matrix";
import { createMemoryState } from "@chat-adapter/state-memory";
import type { Message, Thread } from "chat";
import { chatSdkChannel } from "eve/channels/chat-sdk";

export const { bot, channel, send } = chatSdkChannel({
  userName: "My Agent",
  adapters: {
    matrix: createMatrixAdapter(),
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

await bot.initialize();

export default channel;
