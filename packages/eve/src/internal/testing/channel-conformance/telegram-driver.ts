import { telegramChannel } from "#public/channels/telegram/index.js";
import {
  type ChannelDriver,
  type PlatformCall,
  recordingFetch,
} from "#internal/testing/channel-conformance/harness.js";

const SECRET = "telegram-conformance-secret";
let nextChatId = 1000;

interface InlineButton {
  readonly callback_data?: string;
  readonly text: string;
}

/** Drives the Telegram channel through its Bot API webhook in a private chat. */
export function telegramDriver(): ChannelDriver {
  // A fresh chat per driver keeps each test's session apart in the shared workflow world.
  nextChatId += 1;
  const CHAT = { id: nextChatId, type: "private" } as const;
  const PERSON = { first_name: "Alice", id: nextChatId, is_bot: false } as const;
  let updateId = 0;
  let messageId = 0;

  function update(payload: Record<string, unknown>): Request {
    updateId += 1;
    return new Request("https://agent.example.com/eve/v1/telegram", {
      body: JSON.stringify({ update_id: updateId, ...payload }),
      headers: {
        "content-type": "application/json",
        "x-telegram-bot-api-secret-token": SECRET,
      },
      method: "POST",
    });
  }

  async function decode(request: Request): Promise<PlatformCall> {
    const method = new URL(request.url).pathname.split("/").at(-1)!;
    const text = await request.text();
    messageId += 1;
    return {
      body: text === "" ? {} : JSON.parse(text),
      method,
      response: { ok: true, result: { chat: CHAT, date: 0, message_id: messageId } },
    };
  }

  return {
    name: "telegram",
    capabilities: ["buttons", "text-replies"],
    createChannel: (record) =>
      telegramChannel({
        api: { fetch: recordingFetch(record, decode) },
        credentials: { botToken: "bot-token", webhookSecretToken: SECRET },
      }),
    message: (text) =>
      update({ message: { chat: CHAT, date: 0, from: PERSON, message_id: 1000 + updateId, text } }),
    findOptions(call, prompt) {
      const body = call.body as {
        readonly reply_markup?: { readonly inline_keyboard?: readonly InlineButton[][] };
        readonly text?: string;
      };
      if (call.method !== "sendMessage" || body.text?.includes(prompt) !== true) return undefined;
      // An open-ended question posts a ForceReply prompt with no keyboard.
      return (body.reply_markup?.inline_keyboard ?? [])
        .flat()
        .filter((button) => button.callback_data !== undefined)
        .map((button) => ({ handle: button.callback_data, label: button.text }));
    },
    press: (option) =>
      update({
        callback_query: {
          data: option.handle,
          from: PERSON,
          id: `callback-${updateId}`,
          message: { chat: CHAT, date: 0, message_id: 1 },
        },
      }),
    postedText: (call: PlatformCall) =>
      call.method === "sendMessage" || call.method === "editMessageText"
        ? (call.body as { readonly text?: string }).text
        : undefined,
  };
}
