/**
 * Loads each Chat SDK channel template from eve's registry exactly as `eve add`
 * installs it, with its real adapter package, and checks what a person on that
 * platform experiences. Webhooks are synthetic (the adapters' own parsing is
 * theirs to test), and no request leaves the process: any network call an
 * adapter makes counts as the platform accepting it.
 */
import { generateKeyPairSync } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { buildAdapterContext } from "#channel/adapter-context.js";
import type { ChannelAdapter } from "#channel/adapter.js";
import type { CompiledChannel } from "#channel/compiled-channel.js";
import {
  callChannelEvent,
  channelEvent,
  compiledChannel,
  postToChannelRoute,
  stubSessionAccessor,
} from "#internal/testing/mocks/mock-channel-calls.js";
import { mockChannelContext } from "#internal/testing/mocks/mock-channel-operations.js";
import type { ChatSdkChannelState } from "#public/channels/chat-sdk/index.js";
import type { Adapter } from "#compiled/chat/index.js";
import { Chat, Message, parseMarkdown } from "#compiled/chat/index.js";
import { createMemoryState } from "#compiled/@chat-adapter/state-memory/index.js";

vi.mock("eve/channels/chat-sdk", () => import("#public/channels/chat-sdk/index.js"));

const DOCS = fileURLToPath(new URL("../../../../../../apps/docs/", import.meta.url));

interface RegistryItem {
  readonly name: string;
  readonly envVars?: Record<string, string>;
  readonly files: readonly { readonly path: string }[];
  readonly meta?: { readonly eve?: { readonly implementation?: string } };
}

const templates = (
  JSON.parse(readFileSync(join(DOCS, "registry.json"), "utf8")) as { items: RegistryItem[] }
).items.filter((item) => item.meta?.eve?.implementation === "chat-sdk");

const b64 = (value: string) => Buffer.from(value).toString("base64url");

interface Platform {
  /** A direct-message thread, in the id format the adapter decodes. */
  readonly thread: string;
  /** The id of the `sent`th message the adapter sent, when it checks their format. */
  readonly sentMessageId?: (sent: number) => string;
  /** Why the adapter can't send without a live platform, if it can't. */
  readonly streamingUntestable?: string;
}

const PLATFORMS: Record<string, Platform> = {
  "channel/chat-sdk-agentphone": { thread: "agentphone:+15550000000:+15550001111" },
  "channel/chat-sdk-beeper": {
    thread: `matrix:${encodeURIComponent("!dm:example.com")}`,
    streamingUntestable: "the adapter builds its Matrix client only after a live login",
  },
  "channel/chat-sdk-dial": { thread: "dial:+15550000000:+15550001111" },
  "channel/chat-sdk-gchat": {
    thread: "gchat:spaces/AAAA:dm",
    sentMessageId: (sent) => `spaces/AAAA/messages/m${sent}`,
  },
  "channel/chat-sdk-gmail": {
    thread: `gmail:${b64("agent@example.com")}:dm:${b64("alice@example.com")}`,
  },
  "channel/chat-sdk-kapso": { thread: "kapso:1234567890:15550001111" },
  "channel/chat-sdk-lark": { thread: "lark:oc_dm:om_root" },
  "channel/chat-sdk-liveblocks": { thread: "liveblocks:room-1:th_1" },
  "channel/chat-sdk-messenger": { thread: "messenger:1234567890" },
  "channel/chat-sdk-novu": { thread: "novu:slack:integration-1:conversation-1:1" },
  "channel/chat-sdk-resend": { thread: "resend:alice@example.com:root1" },
  "channel/chat-sdk-sendblue": { thread: `sendblue:${b64("+15550000000")}:${b64("+15550001111")}` },
  "channel/chat-sdk-velt": { thread: "velt:org-1:doc-1:annotation-1" },
  "channel/chat-sdk-whatsapp": { thread: "whatsapp:1234567890:15550001111" },
  "channel/chat-sdk-x": { thread: "x:dm:1111-2222" },
  "channel/chat-sdk-zernio": { thread: "zernio:account-1:conversation-1" },
};

/** Values for env vars whose format the adapter checks; the rest get a placeholder. */
const SAMPLE_ENV: Record<string, string> = {
  GMAIL_LABEL_ID: "Label_1",
  GMAIL_MAILBOX: "agent@example.com",
  GMAIL_PUBSUB_AUDIENCE: "https://agent.example.com/eve/v1/gmail",
  GMAIL_PUBSUB_SERVICE_ACCOUNT_EMAIL: "push@project.iam.gserviceaccount.com",
  GMAIL_SUBSCRIPTION: "projects/project/subscriptions/gmail",
  GMAIL_TOPIC_NAME: "projects/project/topics/gmail",
  GOOGLE_CHAT_CREDENTIALS: JSON.stringify({
    client_email: "bot@project.iam.gserviceaccount.com",
    // The adapter signs its token request with this key before calling Google.
    private_key: generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({
      format: "pem",
      type: "pkcs8",
    }),
    project_id: "project",
    type: "service_account",
  }),
  GOOGLE_CHAT_PROJECT_NUMBER: "123456789",
  LIVEBLOCKS_SECRET_KEY: "sk_test_conformance",
  LIVEBLOCKS_WEBHOOK_SECRET: "whsec_Y29uZm9ybWFuY2U=",
  MATRIX_BASE_URL: "https://matrix.example.com",
  REDIS_URL: "redis://127.0.0.1:6379",
  RESEND_FROM_ADDRESS: "agent@example.com",
  SENDBLUE_FROM_NUMBER: "+15550000000",
};

// ── Network guard ───────────────────────────────────────────────────────────

let networkAttempts = 0;

class NetworkAttempt extends Error {}

function attemptNetwork(): never {
  networkAttempts += 1;
  throw new NetworkAttempt("Network access is blocked in registry template tests.");
}

/** Runs `call`, treating a network request it makes as the platform accepting it. */
async function reachesPlatform<T>(call: () => Promise<T>): Promise<T | "sent"> {
  const before = networkAttempts;
  try {
    return await call();
  } catch (error) {
    if (networkAttempts > before) return "sent";
    throw error;
  }
}

beforeAll(() => {
  vi.stubGlobal("fetch", attemptNetwork);
  const require = createRequire(import.meta.url);
  for (const http of [require("node:http"), require("node:https")]) {
    vi.spyOn(http, "request").mockImplementation(attemptNetwork);
    vi.spyOn(http, "get").mockImplementation(attemptNetwork);
  }
  // Start Chat SDK without the network: adapters whose startup calls the platform
  // (bot identity lookups, logins) start anyway, as they would once it answered.
  // Some templates initialize at import, before a test can reach their adapter,
  // so this hooks Chat SDK's own init path rather than each adapter.
  const ensureInitialized = Reflect.get(Chat.prototype, "ensureInitialized") as () => Promise<void>;
  const tolerant = new WeakSet<Adapter>();
  vi.spyOn(Chat.prototype as any, "ensureInitialized").mockImplementation(function (this: Chat) {
    const adapters = Reflect.get(this, "adapters") as Map<string, Adapter>;
    for (const adapter of adapters.values()) {
      if (tolerant.has(adapter)) continue;
      tolerant.add(adapter);
      const initialize = adapter.initialize.bind(adapter);
      adapter.initialize = async (chat) => {
        await reachesPlatform(() => initialize(chat));
      };
    }
    return ensureInitialized.call(this);
  });
  // The Gmail template keeps state in Redis; give it memory state instead.
  vi.doMock(resolveFromDocs("@chat-adapter/state-redis"), () => ({
    createRedisState: () => createMemoryState(),
  }));
});

afterAll(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

function resolveFromDocs(specifier: string): string {
  const pkg = realpathSync(join(DOCS, "node_modules", specifier));
  const manifest = JSON.parse(readFileSync(join(pkg, "package.json"), "utf8"));
  const entry =
    manifest.exports?.["."]?.import ?? manifest.exports?.["."]?.default ?? manifest.module;
  return join(pkg, typeof entry === "string" ? entry : entry.default);
}

// ── Loading a template ──────────────────────────────────────────────────────

interface LoadedTemplate {
  readonly adapter: Adapter;
  readonly adapterName: string;
  readonly bot: Chat;
  readonly channel: CompiledChannel<ChatSdkChannelState>;
  readonly platform: Platform;
  readonly threadId: string;
}

const loaded = new Map<string, Promise<LoadedTemplate>>();

function loadTemplate(item: RegistryItem): Promise<LoadedTemplate> {
  let pending = loaded.get(item.name);
  if (!pending) {
    pending = importTemplate(item);
    loaded.set(item.name, pending);
  }
  return pending;
}

async function importTemplate(item: RegistryItem): Promise<LoadedTemplate> {
  // Only the env vars the registry tells users to set.
  for (const name of Object.keys(item.envVars ?? {})) {
    vi.stubEnv(name, SAMPLE_ENV[name] ?? `test-${name.toLowerCase()}`);
  }
  const module = (await import(join(DOCS, item.files[0]!.path))) as {
    bot: Chat;
    channel: unknown;
  };
  const channel = compiledChannel<ChatSdkChannelState>(module.channel);
  const adapterName = channel.routes[0]!.path.split("/").at(-1)!;
  const adapter = module.bot.getAdapter(adapterName) as Adapter;
  const platform = PLATFORMS[item.name];
  if (!platform) throw new Error(`Add ${item.name} to PLATFORMS.`);
  const threadId = platform.thread;

  // Webhooks carry `{ id, text, attachments? }`; the template's own handlers take it from there.
  adapter.handleWebhook = async (request, options) => {
    const body = (await request.json()) as {
      id: string;
      text: string;
      attachments?: Message["attachments"];
    };
    await module.bot.processMessage(adapter, threadId, personMessage(threadId, body), options);
    return new Response("ok");
  };
  return { adapter, adapterName, bot: module.bot, channel, platform, threadId };
}

function personMessage(
  threadId: string,
  body: { id: string; text: string; attachments?: Message["attachments"] },
): Message {
  return new Message({
    attachments: body.attachments ?? [],
    author: {
      fullName: "Alice",
      isBot: false,
      isMe: false,
      userId: "alice",
      userName: "alice",
    },
    formatted: parseMarkdown(body.text),
    id: body.id,
    isMention: true,
    metadata: { dateSent: new Date(), edited: false },
    raw: body,
    text: body.text,
    threadId,
  });
}

// ── Driving a template ──────────────────────────────────────────────────────

let nextMessage = 0;

/** Posts webhooks to the template's route at once, with `send` standing in for eve. */
async function deliver(
  template: LoadedTemplate,
  bodies: readonly { text: string; attachments?: Message["attachments"] }[],
  send = vi.fn().mockResolvedValue({ id: "session-1" }),
) {
  const route = template.channel.routes.find((candidate) => candidate.method === "POST");
  if (!route) throw new Error("Expected a POST webhook route.");
  await Promise.all(
    bodies.map((body) => {
      nextMessage += 1;
      return postToChannelRoute(
        template.channel,
        new Request(`https://agent.example.com${route.path}`, {
          body: JSON.stringify({ id: `message-${nextMessage}`, ...body }),
          headers: { "content-type": "application/json" },
          method: "POST",
        }),
        mockChannelContext<ChatSdkChannelState>(send),
      );
    }),
  );
  return send;
}

/**
 * Streams `deltas` through the template's channel as eve would, then returns
 * the messages the person is left looking at: each post adds one, each edit
 * replaces it.
 */
async function streamReply(template: LoadedTemplate, deltas: readonly string[]) {
  const shown = new Map<string, string>();
  let sent = 0;
  const adapter = template.adapter;
  const postMessage = adapter.postMessage.bind(adapter);
  const editMessage = adapter.editMessage.bind(adapter);
  const textOf = (message: unknown) => (message as { markdown?: string }).markdown ?? "";
  adapter.postMessage = async (threadId, message) => {
    const result = await reachesPlatform(() => postMessage(threadId, message));
    sent += 1;
    const id =
      result === "sent" ? (template.platform.sentMessageId?.(sent) ?? `sent-${sent}`) : result.id;
    shown.set(id, textOf(message));
    return result === "sent" ? { id, raw: {}, threadId } : result;
  };
  adapter.editMessage = async (threadId, messageId, message) => {
    const result = await reachesPlatform(() => editMessage(threadId, messageId, message));
    shown.set(messageId, textOf(message));
    return result === "sent" ? { id: messageId, raw: {}, threadId } : result;
  };
  try {
    const state: ChatSdkChannelState = {
      thread: {
        _type: "chat:Thread",
        adapterName: template.adapterName,
        channelId: template.adapter.channelIdFromThreadId(template.threadId),
        id: template.threadId,
        isDM: true,
      },
    };
    const channelAdapter = { ...template.channel.adapter, state } as ChannelAdapter<any>;
    const ctx = buildAdapterContext(channelAdapter, stubSessionAccessor());
    for (const [sequence, messageDelta] of deltas.entries()) {
      await callChannelEvent(
        channelAdapter,
        channelEvent("message.appended", {
          messageDelta,
          sequence,
          stepIndex: 0,
          turnId: "turn-1",
        }),
        ctx,
      );
    }
    await callChannelEvent(
      channelAdapter,
      channelEvent("message.completed", {
        finishReason: "stop",
        message: deltas.join(""),
        sequence: deltas.length,
        stepIndex: 0,
        turnId: "turn-1",
      }),
      ctx,
    );
  } finally {
    adapter.postMessage = postMessage;
    adapter.editMessage = editMessage;
  }
  return [...shown.values()];
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe.each(templates.map((item) => [item.name, item] as const))("%s", (_, item) => {
  it("starts with only the env vars the registry lists", async () => {
    await expect(loadTemplate(item)).resolves.toBeDefined();
  });

  it("hands the agent the files a person sends", async () => {
    const template = await loadTemplate(item);
    const send = await deliver(template, [
      {
        attachments: [
          {
            mimeType: "image/png",
            name: "box.png",
            type: "image",
            url: "https://files.example.com/box.png",
          },
        ],
        text: "Here is the damaged box.",
      },
    ]);

    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]?.[1].message).toEqual([
      { text: "Here is the damaged box.", type: "text" },
      expect.objectContaining({ filename: "box.png", type: "file" }),
    ]);
  });

  it("hands the agent every message a person sends in quick succession", async () => {
    const template = await loadTemplate(item);
    // eve takes a moment to accept each message, so the second arrives mid-handoff.
    const send = vi.fn(
      () => new Promise((resolve) => setTimeout(() => resolve({ id: "session-1" }), 50)),
    );
    await deliver(
      template,
      [{ text: "Quick question about my order" }, { text: "it is B-2002" }],
      send,
    );

    expect(send.mock.calls.map(([, input]: any) => input.message)).toEqual([
      "Quick question about my order",
      "it is B-2002",
    ]);
  });

  it.skipIf(PLATFORMS[item.name]?.streamingUntestable)(
    "shows the person a streamed reply once, in full",
    async () => {
      const template = await loadTemplate(item);

      expect(await streamReply(template, ["The", " sky", " is blue."])).toEqual([
        "The sky is blue.",
      ]);
    },
  );
});
