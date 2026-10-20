import { createWhatsAppAdapter } from "@chat-adapter/whatsapp";
import { createMemoryState } from "@chat-adapter/state-memory";
import type { Message, Thread } from "chat";
import { chatSdkChannel, messageToUserContent } from "eve/channels/chat-sdk";

export const { bot, channel, send } = chatSdkChannel({
  userName: "My Agent",
  adapters: { whatsapp: createWhatsAppAdapter() },
  state: createMemoryState(),
  // Hand every message to eve, even mid-reply, so eve can steer the running turn.
  concurrency: "concurrent",
  // WhatsApp can't edit sent messages, so send each reply whole.
  streaming: false,
});

bot.onNewMention(async (thread: Thread, message: Message) => {
  await thread.subscribe();
  await send(messageToUserContent(message), { thread });
});

bot.onSubscribedMessage(async (thread: Thread, message: Message) => {
  await send(messageToUserContent(message), { thread });
});

export default channel;
