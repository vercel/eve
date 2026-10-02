import { telegramChannel } from "#public/channels/telegram/index.js";
import {
  type ChannelDriver,
  type Person,
  type PlatformCall,
  type RenderedOption,
  type Surface,
  recordingFetch,
  linkTargets,
} from "#internal/testing/channel-conformance/harness.js";

const SECRET = "telegram-conformance-secret";
const BOT = { first_name: "eve", id: 99, is_bot: true, username: "testbot" } as const;
let nextChatId = 1000;

interface InlineButton {
  readonly callback_data?: string;
  readonly text: string;
}

interface MessageBody {
  /** Shows the message to one member of a group only. */
  readonly ephemeral_message_parameters?: unknown;
  readonly message_id?: number;
  readonly reply_markup?: { readonly inline_keyboard?: readonly InlineButton[][] };
  readonly text?: string;
}

interface PressHandle {
  readonly data: string;
  readonly messageId: number;
}

const MESSAGE_WRITES = new Set(["sendMessage", "editMessageText", "editMessageReplyMarkup"]);

/** A send's id comes back from Telegram; an edit names the message it rewrites. */
function messageIdOf(call: PlatformCall): number {
  return call.method === "sendMessage"
    ? (call.response as { readonly result: { readonly message_id: number } }).result.message_id
    : (call.body as MessageBody).message_id!;
}

function inlineOptions(call: PlatformCall): RenderedOption[] {
  const messageId = messageIdOf(call);
  return ((call.body as MessageBody).reply_markup?.inline_keyboard ?? [])
    .flat()
    .flatMap((button) =>
      button.callback_data === undefined
        ? []
        : [
            {
              handle: { data: button.callback_data, messageId } satisfies PressHandle,
              label: button.text,
            },
          ],
    );
}

/**
 * Drives the Telegram channel through its Bot API webhook, in a supergroup by
 * default or in a private chat.
 */
export function telegramDriver(surface: Exclude<Surface, "public"> = "shared"): ChannelDriver {
  const group = surface === "shared";
  // A fresh chat per driver keeps each test's session apart in the shared workflow world.
  nextChatId += 1;
  const CHAT = group
    ? { id: -nextChatId, title: "Release crew", type: "supergroup" }
    : { id: nextChatId, type: "private" };
  const PERSON = { first_name: "Alice", id: nextChatId, is_bot: false } as const;
  const PEOPLE = {
    alice: PERSON,
    bob: { first_name: "Bob", id: nextChatId + 500_000, is_bot: false },
  } as const;
  let updateId = 0;
  let messageId = 0;
  /** The bot's latest message, which a person in a group replies to so the bot hears them. */
  let lastBotMessage: number | undefined;

  /**
   * A group's default policy hears only mentions and replies to the bot, and a
   * mention starts a new conversation, so a person mentions the bot once and
   * then replies to its latest message. The mention sits on its own line so
   * the test model's line-based directives still read the message.
   */
  function addressed(text: string): Record<string, unknown> {
    if (!group) return { text };
    if (lastBotMessage === undefined) return { text: `${text}\n@${BOT.username}` };
    return {
      reply_to_message: { chat: CHAT, date: 0, from: BOT, message_id: lastBotMessage },
      text,
    };
  }

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
    if (method === "sendMessage") lastBotMessage = messageId;
    return {
      body: text === "" ? {} : JSON.parse(text),
      method,
      response: { ok: true, result: { chat: CHAT, date: 0, message_id: messageId } },
    };
  }

  return {
    name: group ? "telegram" : "telegram-dm",
    capabilities: !group
      ? ["buttons", "text-replies"]
      : ["another-person", "buttons", "text-replies"],
    surface,
    createChannel: (record) =>
      telegramChannel({
        api: { fetch: recordingFetch(record, decode) },
        botUsername: BOT.username,
        credentials: { botToken: "bot-token", webhookSecretToken: SECRET },
      }),
    message: (text) =>
      update({
        message: {
          chat: CHAT,
          date: 0,
          from: PERSON,
          message_id: 1000 + updateId,
          ...addressed(text),
        },
      }),
    findOptions(call, prompt) {
      const body = call.body as MessageBody;
      if (call.method !== "sendMessage" || body.text?.includes(prompt) !== true) return undefined;
      // An open-ended question posts a ForceReply prompt with no keyboard.
      return inlineOptions(call);
    },
    shownMessage(call) {
      if (!MESSAGE_WRITES.has(call.method)) return undefined;
      return {
        id: String(messageIdOf(call)),
        links: linkTargets((call.body as { readonly reply_markup?: unknown }).reply_markup),
        onlyPerson: (call.body as MessageBody).ephemeral_message_parameters !== undefined,
        // Telegram drops a message's inline keyboard when an edit omits `reply_markup`.
        options: inlineOptions(call),
        text: (call.body as MessageBody).text ?? "",
      };
    },
    personShownAs: [PERSON.first_name],
    press: (option, person: Person) => {
      const { data, messageId } = option.handle as PressHandle;
      return update({
        callback_query: {
          data,
          from: PEOPLE[person],
          id: `callback-${updateId}`,
          message: { chat: CHAT, date: 0, message_id: messageId },
        },
      });
    },
    postedText: (call: PlatformCall) =>
      call.method === "sendMessage" || call.method === "editMessageText"
        ? (call.body as { readonly text?: string }).text
        : undefined,
  };
}
