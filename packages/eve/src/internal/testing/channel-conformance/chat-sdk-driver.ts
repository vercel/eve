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
import type { ChannelDriver, PlatformCall } from "#internal/testing/channel-conformance/harness.js";

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

function buttonsOf(call: PlatformCall): { handle: PressHandle; label: string }[] {
  const card = cardOf(call.body as AdapterPostableMessage);
  if (card === undefined) return [];
  const messageId = messageIdOf(call);
  return nodes(card)
    .filter((node) => node.type === "button" && node.id !== undefined)
    .map((button) => ({ handle: { button, messageId }, label: button.label ?? "" }));
}

/**
 * Drives `chatSdkChannel` with a card-capable direct-message adapter: one
 * thread, no streaming, and every message handed to eve with an empty
 * `context`. The fake adapter is the platform: it reads inbound JSON and
 * records every post and edit.
 */
export function chatSdkDriver(): ChannelDriver {
  const driver = chatSdkDriverWith({ name: "chat-sdk", render: (posted) => posted });
  return {
    ...driver,
    capabilities: ["buttons", "text-replies"],
    findOptions(call, prompt) {
      if (!isPost(call)) return undefined;
      const card = cardOf(call.body as AdapterPostableMessage);
      if (card === undefined || !texts(card).includes(prompt)) return undefined;
      return buttonsOf(call);
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
  });
  return {
    ...driver,
    capabilities: ["text-replies"],
    findOptions(call, prompt) {
      if (!isPost(call) || typeof call.body !== "string" || !call.body.includes(prompt)) {
        return undefined;
      }
      // #3715's fallback lists each choice as `"<id>" (<label>)`.
      return [...call.body.matchAll(/"[^"]+" \(([^)]+)\)/gu)].map(([, label]) => ({
        handle: label,
        label: label!,
      }));
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
}): Omit<ChannelDriver, "capabilities" | "findOptions" | "press"> & {
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
      const adapter = fakeAdapter(threadId, record, () => (sequence += 1), input.render);
      const bridge = chatSdkChannel({
        adapters: { [ADAPTER]: adapter },
        concurrency: "concurrent",
        routes: { [ADAPTER]: `/eve/v1/${ADAPTER}` },
        state: createMemoryState() as StateAdapter,
        streaming: false,
        userName: "eve",
      });
      bridge.bot.onDirectMessage(async (thread, message) => {
        await bridge.send(message.text, { auth: null, context: [], thread });
      });
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
): Adapter {
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
          inboundMessage(threadId, id, body.text),
          options,
        );
      }
      return new Response("ok");
    },
    channelIdFromThreadId: () => threadId,
    decodeThreadId: (id: string) => ({ threadId: id }),
    encodeThreadId: (input: { threadId: string }) => input.threadId,
    getChannelVisibility: () => "private" as const,
    isDM: () => true,
    parseMessage: (raw: { text?: string }) => inboundMessage(threadId, "parsed", raw.text ?? ""),
    renderFormatted: () => "",
    fetchMessages: async () => ({ messages: [] }),
    fetchThread: async (id: string) => ({
      channelId: threadId,
      channelVisibility: "private" as const,
      id,
      isDM: true,
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

function inboundMessage(threadId: string, id: string, text: string): Message {
  return new Message({
    attachments: [],
    author: PERSON,
    formatted: parseMarkdown(text),
    id,
    isMention: false,
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

function nodes(node: CardNode): CardNode[] {
  return [node, ...(node.children ?? []).flatMap(nodes)];
}

function texts(node: CardNode): string {
  return nodes(node)
    .flatMap((child) => (child.content === undefined ? [] : [child.content]))
    .join("\n");
}
