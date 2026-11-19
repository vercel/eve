import { connectLinqCredentials } from "@vercel/connect/eve";
import { LinqAPIV3 } from "@linqapp/sdk";
import { env } from "@/lib/environment/env";

export const linqCredentials = env.LINQ_CONNECTOR
  ? connectLinqCredentials(env.LINQ_CONNECTOR)
  : {
      webhookVerifier: () => false,
      apiKey() {
        throw new Error("LINQ_CONNECTOR is not configured for this deployment.");
      },
    };

async function linqClient() {
  return new LinqAPIV3({ apiKey: await linqCredentials.apiKey() });
}

export function directLinqChatId(threadId: string) {
  const chatId = /^linq:([^:#]+)(?::dm)?$/.exec(threadId)?.[1];
  return chatId === "pending" ? undefined : chatId;
}

export async function isDirectLinqThread(threadId: string, recipientPhone?: string) {
  const chatId = directLinqChatId(threadId);
  if (!chatId) return false;
  const client = await linqClient();
  try {
    const chat = await client.chats.retrieve(chatId, { maxRetries: 0, timeout: 5000 });
    return (
      chat.is_group === false &&
      (recipientPhone === undefined ||
        chat.handles.some(
          (handle) =>
            handle.handle === recipientPhone &&
            !handle.is_me &&
            !handle.left_at &&
            (handle.status == null || handle.status === "active"),
        ))
    );
  } catch (error) {
    if (error instanceof LinqAPIV3.NotFoundError) return false;
    throw error;
  }
}

export async function sendNativeLinqMessage(
  chatId: string,
  message: Parameters<LinqAPIV3["chats"]["messages"]["send"]>[1]["message"],
  options?: Parameters<LinqAPIV3["chats"]["messages"]["send"]>[2],
) {
  const client = await linqClient();
  return client.chats.messages.send(chatId, { message }, options);
}
