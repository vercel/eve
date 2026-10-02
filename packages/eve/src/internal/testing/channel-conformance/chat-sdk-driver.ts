import { chatSdkChannel } from "#public/channels/chat-sdk/index.js";
import {
  type Adapter,
  type AdapterPostableMessage,
  BaseFormatConverter,
  type ChatInstance,
  Message,
  type StateAdapter,
  type WebhookOptions,
  parseMarkdown,
  toPlainText,
} from "#compiled/chat/index.js";
import { createMemoryState } from "#compiled/@chat-adapter/state-memory/index.js";
import {
  type ChannelDriver,
  type PlatformCall,
  type Surface,
  numberedOptions,
} from "#internal/testing/channel-conformance/harness.js";

const ADAPTER = "conformance";
const PERSON = { fullName: "Alice", isBot: false, isMe: false, userId: "alice", userName: "alice" };
let nextThread = 0;

interface CardNode {
  readonly children?: readonly CardNode[];
  readonly content?: string;
  readonly id?: string;
  readonly label?: string;
  readonly type?: string;
  readonly value?: string;
}

type Inbound =
  | { readonly kind: "message"; readonly text: string }
  | {
      readonly kind: "action";
      readonly actionId: string;
      /** The posted message holding the pressed button. */
      readonly messageId: string;
      readonly value?: string;
    };

interface PressHandle {
  readonly button: CardNode;
  readonly messageId: string;
}

function messageIdOf(call: PlatformCall): string {
  return (call.response as { readonly id: string }).id;
}

/** A card's buttons, or only those under `prompt` when the card holds several requests. */
function buttonsOf(call: PlatformCall, prompt?: string): { handle: PressHandle; label: string }[] {
  const card = cardOf(call.body as AdapterPostableMessage);
  if (card === undefined) return [];
  const messageId = messageIdOf(call);
  return nodes(prompt === undefined ? card : requestSection(card, prompt))
    .filter((node) => node.type === "button" && node.id !== undefined)
    .map((button) => ({ handle: { button, messageId }, label: button.label ?? "" }));
}

/**
 * Drives `chatSdkChannel` with a card-capable adapter: one thread, in a
 * workspace channel by default or a direct message, no streaming, and every
 * message handed to eve with an empty `context`. The fake adapter is the
 * platform: it reads inbound JSON and records every post and edit.
 */
export function chatSdkDriver(surface: Exclude<Surface, "public"> = "shared"): ChannelDriver {
  const driver = chatSdkDriverWith({
    name: surface === "private" ? "chat-sdk-dm" : "chat-sdk",
    render: (posted) => posted,
    surface,
  });
  return {
    ...driver,
    capabilities: ["buttons", "text-replies"],
    surface,
    findOptions(call, prompt) {
      if (!isPost(call)) return undefined;
      const card = cardOf(call.body as AdapterPostableMessage);
      if (card === undefined || !texts(card).includes(prompt)) return undefined;
      return buttonsOf(call, prompt);
    },
    shownMessage(call) {
      if (!isPost(call)) return undefined;
      const card = cardOf(call.body as AdapterPostableMessage);
      return {
        id: messageIdOf(call),
        options: buttonsOf(call),
        text: card === undefined ? (driver.postedText(call) ?? "") : texts(card),
      };
    },
    personShownAs: [PERSON.fullName, PERSON.userName],
    press(option) {
      const { button, messageId } = option.handle as PressHandle;
      return driver.inbound({
        actionId: button.id!,
        kind: "action",
        messageId,
        value: button.value,
      });
    },
  };
}

/**
 * The same bridge behind a text-only adapter, as Photon iMessage's behaves:
 * every post reaches the person as the `chat` package's default plain-text
 * rendering, so a card shows only its fallback text and has nothing to press.
 * Photon's real adapter sends over gRPC, so this is the closest in-process
 * stand-in; it covers eve's bridge and the SDK fallback, not Photon itself.
 */
export function chatSdkTextDriver(): ChannelDriver {
  const converter = new PlainTextConverter();
  const driver = chatSdkDriverWith({
    name: "chat-sdk-text",
    render: (posted) => converter.renderPostable(posted),
    surface: "private",
  });
  return {
    ...driver,
    capabilities: ["text-replies"],
    surface: "private",
    findOptions(call, prompt) {
      if (!isPost(call) || typeof call.body !== "string" || !call.body.includes(prompt)) {
        return undefined;
      }
      return numberedOptions(call.body);
    },
    press() {
      throw new Error("A text-only Chat SDK adapter has nothing to press.");
    },
  };
}

class PlainTextConverter extends BaseFormatConverter {
  fromAst(ast: Parameters<BaseFormatConverter["fromAst"]>[0]): string {
    return toPlainText(ast);
  }

  toAst(text: string) {
    return parseMarkdown(text);
  }
}

function chatSdkDriverWith(input: {
  readonly name: string;
  readonly render: (posted: AdapterPostableMessage) => unknown;
  readonly surface: Exclude<Surface, "public">;
}): Omit<ChannelDriver, "capabilities" | "findOptions" | "press" | "surface"> & {
  inbound(body: Inbound): Request;
} {
  nextThread += 1;
  const threadId = `${ADAPTER}:D${nextThread}`;
  let sequence = 0;

  function inbound(body: Inbound): Request {
    return new Request(`https://agent.example.com/eve/v1/${ADAPTER}`, {
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
  }

  return {
    name: input.name,
    inbound,
    createChannel(record) {
      const dm = input.surface === "private";
      const adapter = fakeAdapter(threadId, record, () => (sequence += 1), input.render, dm);
      const bridge = chatSdkChannel({
        adapters: { [ADAPTER]: adapter },
        concurrency: "concurrent",
        routes: { [ADAPTER]: `/eve/v1/${ADAPTER}` },
        state: createMemoryState() as StateAdapter,
        streaming: false,
        userName: "eve",
      });
      if (dm) {
        bridge.bot.onDirectMessage(async (thread, message) => {
          await bridge.send(message.text, { auth: null, context: [], thread });
        });
      } else {
        // The wiring docs/channels/chat-sdk.mdx shows: a mention starts the session, and
        // subscribing lets the rest of the thread continue it without one.
        bridge.bot.onNewMention(async (thread, message) => {
          await thread.subscribe();
          await bridge.send(message.text, { auth: null, context: [], thread });
        });
        bridge.bot.onSubscribedMessage(async (thread, message) => {
          await bridge.send(message.text, { auth: null, context: [], thread });
        });
      }
      return bridge.channel;
    },
    message: (text) => inbound({ kind: "message", text }),
    postedText(call: PlatformCall) {
      if (!isPost(call)) return undefined;
      const posted = call.body as AdapterPostableMessage;
      if (typeof posted === "string") return posted;
      if ("markdown" in posted) return posted.markdown;
      if ("raw" in posted) return posted.raw;
      return undefined;
    },
  };
}

function isPost(call: PlatformCall): boolean {
  return call.method === "postMessage" || call.method === "editMessage";
}

function fakeAdapter(
  threadId: string,
  record: (call: PlatformCall) => void,
  nextId: () => number,
  render: (posted: AdapterPostableMessage) => unknown,
  dm: boolean,
): Adapter {
  const visibility = dm ? ("private" as const) : ("workspace" as const);
  let chat: ChatInstance | null = null;
  const self = {
    name: ADAPTER,
    userName: "eve",
    async initialize(instance: ChatInstance) {
      chat = instance;
    },
    async handleWebhook(request: Request, options?: WebhookOptions) {
      const body = (await request.json()) as Inbound;
      const id = `inbound-${nextId()}`;
      if (body.kind === "action") {
        await chat?.processAction(
          {
            actionId: body.actionId,
            adapter,
            messageId: body.messageId,
            raw: body,
            threadId,
            user: PERSON,
            value: body.value,
          },
          options,
        );
      } else {
        await chat?.processMessage(
          adapter,
          threadId,
          // A person mentions the bot to start a channel thread; Chat routes the rest by subscription.
          inboundMessage(threadId, id, body.text, !dm),
          options,
        );
      }
      return new Response("ok");
    },
    channelIdFromThreadId: () => threadId,
    decodeThreadId: (id: string) => ({ threadId: id }),
    encodeThreadId: (input: { threadId: string }) => input.threadId,
    getChannelVisibility: () => visibility,
    isDM: () => dm,
    parseMessage: (raw: { text?: string }) => inboundMessage(threadId, "parsed", raw.text ?? ""),
    renderFormatted: () => "",
    fetchMessages: async () => ({ messages: [] }),
    fetchThread: async (id: string) => ({
      channelId: threadId,
      channelVisibility: visibility,
      id,
      isDM: dm,
      metadata: {},
    }),
    async postMessage(id: string, posted: AdapterPostableMessage) {
      const messageId = `posted-${nextId()}`;
      record({ body: render(posted), method: "postMessage", response: { id: messageId } });
      return { id: messageId, raw: posted, threadId: id };
    },
    async editMessage(id: string, messageId: string, posted: AdapterPostableMessage) {
      record({ body: render(posted), method: "editMessage", response: { id: messageId } });
      return { id: messageId, raw: posted, threadId: id };
    },
    async addReaction() {},
    async deleteMessage() {},
    async removeReaction() {},
    async startTyping() {},
  };
  // Chat SDK adapters have many optional members; the fake implements the ones eve calls.
  const adapter: Adapter = self as typeof self & Adapter;
  return adapter;
}

function inboundMessage(threadId: string, id: string, text: string, isMention = false): Message {
  return new Message({
    attachments: [],
    author: PERSON,
    formatted: parseMarkdown(text),
    id,
    isMention,
    metadata: { dateSent: new Date("2026-01-01T00:00:00.000Z"), edited: false },
    raw: { text },
    text,
    threadId,
  });
}

function cardOf(posted: AdapterPostableMessage): CardNode | undefined {
  if (typeof posted !== "object" || posted === null) return undefined;
  if ("card" in posted) return posted.card as CardNode;
  return (posted as CardNode).type === "card" ? (posted as CardNode) : undefined;
}

/**
 * A card batching several requests lists each one's prompt text, then its
 * actions. Returns the part of `card` that belongs to `prompt`.
 */
function requestSection(card: CardNode, prompt: string): CardNode {
  const children = card.children ?? [];
  const start = children.findIndex(
    (child) => child.type === "text" && child.content?.includes(prompt),
  );
  if (start < 0) return card;
  const next = children.findIndex((child, index) => index > start && child.type === "text");
  return { ...card, children: children.slice(start, next < 0 ? undefined : next) };
}

function nodes(node: CardNode): CardNode[] {
  return [node, ...(node.children ?? []).flatMap(nodes)];
}

function texts(node: CardNode): string {
  return nodes(node)
    .flatMap((child) => (child.content === undefined ? [] : [child.content]))
    .join("\n");
}
