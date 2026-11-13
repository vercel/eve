import { connectLinqCredentials } from "@vercel/connect/eve";
import { LinqAPIV3 } from "@linqapp/sdk";
import { env } from "@shared/environment";

export const linqCredentials = env.LINQ_CONNECTOR
  ? connectLinqCredentials(env.LINQ_CONNECTOR)
  : {
      apiKey() {
        throw new Error(
          "LINQ_CONNECTOR is not configured for this deployment."
        );
      },
    };

export async function sendNativeLinqMessage(
  chatId: string,
  message: Parameters<LinqAPIV3["chats"]["messages"]["send"]>[1]["message"],
  options?: Parameters<LinqAPIV3["chats"]["messages"]["send"]>[2]
) {
  const apiKey = await linqCredentials.apiKey();
  const client = new LinqAPIV3({ apiKey });
  return client.chats.messages.send(chatId, { message }, options);
}
