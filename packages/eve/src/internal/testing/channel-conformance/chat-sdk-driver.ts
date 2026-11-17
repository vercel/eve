import { chatSdkChannel, messageContentOf } from "#public/channels/chat-sdk/index.js";
import {
  type Adapter,
  type AdapterPostableMessage,
  type Attachment,
  BaseFormatConverter,
  type ChatInstance,
  Message,
  type StateAdapter,
  type WebhookOptions,
  parseMarkdown,
  toPlainText,
} from "#compiled/chat/index.js";
import type { SessionAuthContext } from "#channel/types.js";
import { createMemoryState } from "#compiled/@chat-adapter/state-memory/index.js";
import {
  type ChannelDriver,
  type Person,
  type PlatformCall,
  type Surface,
  numberedOptions,
  linkTargets,
  type SentFile,
} from "#internal/testing/channel-conformance/harness.js";

const ADAPTER = "conformance";
const PERSON = { fullName: "Alice", isBot: false, isMe: false, userId: "alice", userName: "alice" };
const PEOPLE = {
  alice: PERSON,
  bob: { fullName: "Bob", isBot: false, isMe: false, userId: "bob", userName: "bob" },
} as const;

function userAuth(userId: string): SessionAuthContext {
  return { attributes: {}, authenticator: ADAPTER, principalId: userId, principalType: "user" };
}
let nextThread = 0;

interface CardNode {
  readonly children?: readonly CardNode[];
  readonly content?: string;
  readonly id?: string;
  readonly label?: string;
  readonly type?: string;
  readonly value?: string;
}

interface InboundFile extends Pick<SentFile, "mediaType" | "name"> {
  readonly url: string;
}

type Inbound =
  | {
      readonly kind: "message";
      readonly person: Person;
      readonly text: string;
      readonly files?: readonly InboundFile[];
    }
  | {
      readonly kind: "action";
      readonly actionId: string;
      readonly messageId: string;
      readonly person: Person;
      readonly value?: string;
    };

interface PressHandle {
  readonly button: CardNode;
  readonly messageId: string;
}

function messageIdOf(call: PlatformCall): string {
  return (call.response as { readonly id: string }).id;
}

function buttonsOf(call: PlatformCall, prompt?: string): { handle: PressHandle; label: string }[] {
  const card = cardOf(call.body as AdapterPostableMessage);
  if (card === undefined) return [];
  const messageId = messageIdOf(call);
  return nodes(prompt === undefined ? card : requestSection(card, prompt))
    .filter((node) => node.type === "button" && node.id !== undefined)
    .map((button) => ({ handle: { button, messageId }, label: button.label ?? "" }));
}

export function chatSdkDriver(surface: Exclude<Surface, "public"> = "shared"): ChannelDriver {
  const driver = chatSdkDriverWith({
    name: surface === "private" ? "chat-sdk-dm" : "chat-sdk",
    render: (posted) => posted,
    surface,
  });
  return {
    ...driver,
    capabilities:
      surface === "private"
        ? ["attachments", "buttons", "text-replies"]
        : ["attachments", "another-person", "buttons", "text-replies"],
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
        links: linkTargets(card),
        onlyPerson: isPersonDirectMessage(call),
        options: buttonsOf(call),
        text: card === undefined ? (driver.postedText(call) ?? "") : texts(card),
      };
    },
    personShownAs: [PERSON.fullName, PERSON.userName],
    press(option, person: Person) {
      const { button, messageId } = option.handle as PressHandle;
      return driver.inbound({
        actionId: button.id!,
        kind: "action",
        messageId,
        person,
        value: button.value,
      });
    },
  };
}

export function chatSdkTextDriver(): ChannelDriver {
  const converter = new PlainTextConverter();
  const driver = chatSdkDriverWith({
    name: "chat-sdk-text",
    render: (posted) => converter.renderPostable(posted),
    surface: "private",
  });
  return {
    ...driver,
    capabilities: ["attachments", "text-replies"],
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
    shownMessage(call) {
      if (!isPost(call)) return undefined;
      return {
        id: messageIdOf(call),
        onlyPerson: isPersonDirectMessage(call),
        options: [],
        text: driver.postedText(call) ?? "",
      };
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
  const uploads = new Map<string, SentFile>();

  function inbound(body: Inbound): Request {
    return new Request(`https://agent.example.com/eve/v1/${ADAPTER}`, {
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
  }

  return {
    name: input.name,
    personId: PERSON.userId,
    inbound,
    createChannel(record) {
      const dm = input.surface === "private";
      const adapter = fakeAdapter({
        dm,
        nextId: () => (sequence += 1),
        record,
        render: input.render,
        threadId,
        uploads,
      });
      const bridge = chatSdkChannel({
        adapters: { [ADAPTER]: adapter },
        concurrency: "concurrent",
        resolveInputAuth: (event) => userAuth(event.user.userId),
        routes: { [ADAPTER]: `/eve/v1/${ADAPTER}` },
        state: createMemoryState() as StateAdapter,
        streaming: false,
        userName: "eve",
      });
      if (dm) {
        bridge.bot.onDirectMessage(async (thread, message) => {
          await bridge.send(messageContentOf(message), {
            auth: userAuth(message.author.userId),
            context: [],
            thread,
          });
        });
      } else {
        bridge.bot.onNewMention(async (thread, message) => {
          await thread.subscribe();
          await bridge.send(messageContentOf(message), {
            auth: userAuth(message.author.userId),
            context: [],
            thread,
          });
        });
        bridge.bot.onSubscribedMessage(async (thread, message) => {
          await bridge.send(messageContentOf(message), {
            auth: userAuth(message.author.userId),
            context: [],
            thread,
          });
        });
      }
      return bridge.channel;
    },
    message: (text, person, files = []) =>
      inbound({
        files: files.map((file) => {
          const url = `https://files.conformance.example/${uploads.size + 1}/${encodeURIComponent(file.name)}`;
          uploads.set(url, file);
          return { mediaType: file.mediaType, name: file.name, url };
        }),
        kind: "message",
        person,
        text,
      }),
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

const PERSON_DM_THREAD = `${ADAPTER}:direct-message:${PERSON.userId}`;

function isPersonDirectMessage(call: PlatformCall): boolean {
  const { threadId } = call.response as { readonly threadId?: string };
  return threadId === PERSON_DM_THREAD;
}

function fakeAdapter({
  dm,
  nextId,
  record,
  render,
  threadId,
  uploads,
}: {
  readonly dm: boolean;
  readonly nextId: () => number;
  readonly record: (call: PlatformCall) => void;
  readonly render: (posted: AdapterPostableMessage) => unknown;
  readonly threadId: string;
  readonly uploads: ReadonlyMap<string, SentFile>;
}): Adapter {
  async function fetchData(url: string): Promise<Buffer> {
    const file = uploads.get(url);
    record({ body: {}, method: `GET ${url}`, response: {} });
    if (file === undefined || file.downloadable === false) {
      throw new Error(`Failed to fetch file: 403 Forbidden`);
    }
    return Buffer.from(file.bytes);
  }

  const visibility = dm ? ("private" as const) : ("workspace" as const);
  let chat: ChatInstance | null = null;
  const self = {
    name: ADAPTER,
    userName: "eve",
    rehydrateAttachment(attachment: Attachment): Attachment {
      const { url } = attachment;
      return url === undefined ? attachment : { ...attachment, fetchData: () => fetchData(url) };
    },
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
            user: PEOPLE[body.person],
            value: body.value,
          },
          options,
        );
      } else {
        await chat?.processMessage(
          adapter,
          threadId,
          inboundMessage(threadId, id, body.text, !dm, PEOPLE[body.person], body.files, fetchData),
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
    async openDM(userId: string) {
      if (userId !== PERSON.userId) throw new Error(`no direct message with ${userId}`);
      return PERSON_DM_THREAD;
    },
    async postMessage(id: string, posted: AdapterPostableMessage) {
      const messageId = `posted-${nextId()}`;
      record({
        body: render(posted),
        method: "postMessage",
        response: { id: messageId, threadId: id },
      });
      return { id: messageId, raw: posted, threadId: id };
    },
    async editMessage(id: string, messageId: string, posted: AdapterPostableMessage) {
      record({
        body: render(posted),
        method: "editMessage",
        response: { id: messageId, threadId: id },
      });
      return { id: messageId, raw: posted, threadId: id };
    },
    async addReaction() {},
    async deleteMessage() {},
    async removeReaction() {},
    async startTyping() {},
  };
  const adapter: Adapter = self as typeof self & Adapter;
  return adapter;
}

function inboundMessage(
  threadId: string,
  id: string,
  text: string,
  isMention = false,
  author: (typeof PEOPLE)[Person] = PERSON,
  files: readonly InboundFile[] = [],
  fetchData?: (url: string) => Promise<Buffer>,
): Message {
  return new Message({
    attachments: files.map((file) => ({
      fetchData: fetchData && (() => fetchData(file.url)),
      mimeType: file.mediaType,
      name: file.name,
      type: file.mediaType.startsWith("image/") ? ("image" as const) : ("file" as const),
      url: file.url,
    })),
    author,
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
