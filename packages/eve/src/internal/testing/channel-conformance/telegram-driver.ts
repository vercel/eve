import { telegramContinuationToken } from "#public/channels/telegram/api.js";
import { telegramChannel } from "#public/channels/telegram/index.js";
import {
  type ChannelDriver,
  type Person,
  type PlatformCall,
  type RenderedOption,
  type Surface,
  recordingFetch,
  linkTargets,
  type SentFile,
  serveFile,
} from "#internal/testing/channel-conformance/harness.js";

const SECRET = "telegram-conformance-secret";
const BOT = { first_name: "eve", id: 99, is_bot: true, username: "testbot" } as const;
let nextChatId = 1000;

interface InlineButton {
  readonly callback_data?: string;
  readonly text: string;
}

interface MessageBody {
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

function messageIdOf(call: PlatformCall): number {
  return call.method === "sendMessage"
    ? (call.response as { readonly result: { readonly message_id: number } }).result.message_id
    : (call.body as MessageBody).message_id!;
}

function inlineOptions(call: PlatformCall): RenderedOption[] {
  const messageId = messageIdOf(call);
  return ((call.body as MessageBody).reply_markup?.inline_keyboard ?? []).flat().flatMap((button) =>
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

export function telegramDriver(surface: Exclude<Surface, "public"> = "shared"): ChannelDriver {
  const group = surface === "shared";
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
  let lastBotMessage: number | undefined;
  const texts = new Map<number, string>();
  const keptText = new WeakMap<PlatformCall, string>();

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

  const uploads = new Map<string, SentFile>();
  function attached(files: readonly SentFile[]): Record<string, unknown> {
    const [file] = files;
    if (file === undefined) return {};
    const fileId = `file_${uploads.size + 1}`;
    uploads.set(fileId, file);
    return file.mediaType.startsWith("image/")
      ? { photo: [{ file_id: fileId, file_size: file.bytes.length, height: 1, width: 1 }] }
      : {
          document: {
            file_id: fileId,
            file_name: file.name,
            file_size: file.bytes.length,
            mime_type: file.mediaType,
          },
        };
  }

  async function decode(request: Request): Promise<PlatformCall> {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/file/")) {
      const fileId = url.pathname.split("/").at(-1)!;
      return {
        body: {},
        method: `GET ${url.pathname}`,
        response: serveFile(uploads.get(fileId), "application/octet-stream"),
      };
    }
    const method = url.pathname.split("/").at(-1)!;
    const text = await request.text();
    if (method === "getFile") {
      const { file_id } = JSON.parse(text) as { readonly file_id: string };
      return {
        body: { file_id },
        method,
        response: { ok: true, result: { file_id, file_path: file_id } },
      };
    }
    messageId += 1;
    if (method === "sendMessage") lastBotMessage = messageId;
    const call: PlatformCall = {
      body: text === "" ? {} : JSON.parse(text),
      method,
      response: { ok: true, result: { chat: CHAT, date: 0, message_id: messageId } },
    };
    const id = messageIdOf(call);
    if (method === "editMessageReplyMarkup") keptText.set(call, texts.get(id) ?? "");
    else if (MESSAGE_WRITES.has(method)) texts.set(id, (call.body as MessageBody).text ?? "");
    return call;
  }

  return {
    name: group ? "telegram" : "telegram-dm",
    space: group
      ? { id: `telegram:${CHAT.id}`, type: "shared" }
      : { id: `telegram:${CHAT.id}`, type: "direct", visibility: "private" },
    personId: String(PERSON.id),
    capabilities: !group
      ? ["attachments", "buttons", "text-replies"]
      : ["attachments", "another-person", "buttons", "text-replies"],
    surface,
    createChannel: (record) =>
      telegramChannel({
        api: { fetch: recordingFetch(record, decode) },
        botUsername: BOT.username,
        credentials: { botToken: "bot-token", webhookSecretToken: SECRET },
      }),
    message: (text, person, files = []) => {
      const message: Record<string, unknown> = {
        chat: CHAT,
        date: 0,
        from: PEOPLE[person],
        message_id: 1000 + updateId,
        ...addressed(text),
      };
      if (files.length > 0) {
        message.caption = message.text;
        delete message.text;
        Object.assign(message, attached(files));
      }
      return update({ message });
    },
    findOptions(call, prompt) {
      const body = call.body as MessageBody;
      if (call.method !== "sendMessage" || body.text?.includes(prompt) !== true) return undefined;
      return inlineOptions(call);
    },
    shownMessage(call) {
      if (call.method === "answerCallbackQuery") {
        const { callback_query_id: id, text } = call.body as {
          readonly callback_query_id: string;
          readonly text?: string;
        };
        return text === undefined
          ? undefined
          : { id: `callback:${id}`, onlyPerson: true, options: [], text };
      }
      if (!MESSAGE_WRITES.has(call.method)) return undefined;
      return {
        id: String(messageIdOf(call)),
        links: linkTargets((call.body as { readonly reply_markup?: unknown }).reply_markup),
        onlyPerson: (call.body as MessageBody).ephemeral_message_parameters !== undefined,
        options: inlineOptions(call),
        text: keptText.get(call) ?? (call.body as MessageBody).text ?? "",
      };
    },
    personShownAs: [PERSON.first_name],
    nextAddress: () =>
      group && lastBotMessage !== undefined
        ? telegramContinuationToken({ chatId: CHAT.id, conversationId: lastBotMessage })
        : undefined,
    press: (option, person: Person) => {
      const { data, messageId } = option.handle as PressHandle;
      return update({
        callback_query: {
          data,
          from: PEOPLE[person],
          id: `callback-${updateId}`,
          message: { chat: CHAT, date: 0, message_id: messageId, text: texts.get(messageId) },
        },
      });
    },
    postedText: (call: PlatformCall) =>
      call.method === "sendMessage" || call.method === "editMessageText"
        ? (call.body as { readonly text?: string }).text
        : undefined,
  };
}
