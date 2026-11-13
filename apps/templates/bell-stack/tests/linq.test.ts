import { createHmac, randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import linq from "../agent/channels/linq";
import { ContextContainer, contextStorage } from "../node_modules/eve/dist/src/context/container.js";
import { SessionKey } from "../node_modules/eve/dist/src/context/keys.js";
import type { ChannelAdapter } from "../node_modules/eve/dist/src/channel/adapter.js";

const receivingNumber = "+12025550100";
const senderNumber = "+12025550123";
const signingKey = Buffer.from("bell-test-key-for-webhooks-only!!");
const route = linq.routes.find((entry) => entry.method === "POST")!;
type RouteContext = Parameters<typeof route.handler>[1];

beforeEach(() => {
  vi.stubEnv("LINQ_API_KEY", "linq-test-key");
  vi.stubEnv("LINQ_WEBHOOK_SECRET", `whsec_${signingKey.toString("base64")}`);
  vi.stubEnv("BELL_LINQ_PHONE_NUMBER", receivingNumber);
  vi.stubEnv("BELL_LINQ_ALLOWED_SENDERS", senderNumber);
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const url = input instanceof Request ? input.url : String(input);
    if (!url.startsWith("https://api.linqapp.com/api/partner/v3/chats/") || !url.endsWith("/read")) {
      throw new Error(`Unexpected provider request in Linq test: ${url}`);
    }
    return new Response(null, { status: 204 });
  }));
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

function message(chatId = randomUUID()) {
  return {
    api_version: "v3",
    webhook_version: "2026-02-03",
    event_type: "message.received",
    event_id: randomUUID(),
    created_at: new Date().toISOString(),
    data: {
      id: randomUUID(),
      chat: { id: chatId, is_group: false, owner_handle: { handle: receivingNumber, is_me: true } },
      direction: "inbound",
      sender_handle: { id: "sender-handle-id", handle: senderNumber, is_me: false },
      sent_at: new Date().toISOString(),
      parts: [{ type: "text", value: "Open Best Buy and tell me the homepage title." }],
    },
  };
}

async function deliver(event: ReturnType<typeof message>, options: { tamper?: boolean; age?: number; unsigned?: boolean } = {}) {
  const body = JSON.stringify(event);
  const timestamp = String(Math.floor(Date.now() / 1_000) - (options.age ?? 0));
  const signature = createHmac("sha256", signingKey)
    .update(`${event.event_id}.${timestamp}.${body}`).digest("base64");
  const headers = new Headers({ "content-type": "application/json" });
  if (!options.unsigned) {
    headers.set("webhook-id", event.event_id);
    headers.set("webhook-timestamp", timestamp);
    headers.set("webhook-signature", `v1,${signature}`);
  }
  const request = new Request("https://bell.example/eve/v1/linq", {
    method: "POST", headers, body: options.tamper ? `${body} ` : body,
  });
  const tasks: Promise<unknown>[] = [];
  const dispatch = vi.fn(async () => undefined);
  // Stop at the real adapter's Eve dispatch boundary; never run a model or browser.
  const from = vi.fn(() => new Proxy({}, {
    get(_target, property) {
      if (property === "send") return dispatch;
      throw new Error(`Unexpected Eve operation: ${String(property)}`);
    },
  })) as unknown as RouteContext["from"];
  const unsupported = () => { throw new Error("Unexpected Eve route operation"); };
  const response = await route.handler(request, {
    from, resolveSession: unsupported, attachSession: unsupported, to: unsupported,
    describe: unsupported, listSkillFiles: unsupported, readSkill: unsupported, invokeTool: unsupported,
    params: {}, requestIp: null, waitUntil: (task) => { tasks.push(task); },
  });
  if (!(response instanceof Response)) throw new Error("Expected an HTTP webhook response.");
  for (const task of tasks) await task;
  return { response, from, dispatch };
}

describe("Bell's signed Linq webhook", () => {
  it("dispatches a verified direct message to Bell with sender auth and chat state", async () => {
    const event = message();
    const { response, from, dispatch } = await deliver(event);
    expect(response.status).toBe(200);
    expect(from).toHaveBeenCalledWith(expect.stringContaining(event.data.chat.id));
    expect(dispatch).toHaveBeenCalledOnce();
    expect(dispatch).toHaveBeenCalledWith(event.data.parts[0].value, expect.objectContaining({
      context: [expect.stringContaining("Bell's private Linq")],
      auth: expect.objectContaining({ principalId: "linq:sender-handle-id", principalType: "user", attributes: expect.objectContaining({ bell_watch_chat: event.data.chat.id, bell_watch_sender: senderNumber, bell_watch_line: receivingNumber }) }),
      state: { thread: expect.objectContaining({ isDM: true }) },
    }));
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("keeps follow-ups on the same Eve channel address with steer enabled", async () => {
    const chatId = randomUUID();
    const first = await deliver(message(chatId));
    const second = await deliver(message(chatId));
    expect(first.dispatch).toHaveBeenCalledOnce();
    expect(second.dispatch).toHaveBeenCalledOnce();
    expect(first.from).toHaveBeenCalledWith(expect.any(String));
    expect(vi.mocked(first.from).mock.calls[0][0]).toBe(vi.mocked(second.from).mock.calls[0][0]);
    expect(linq.turnPolicy).toBe("steer");
  });

  it("delivers OAuth challenges and connection completion to the originating Linq thread", async () => {
    const post = vi.fn(async () => ({ id: "oauth-message" }));
    const editMessage = vi.fn();
    const startTyping = vi.fn();
    const channel = {
      thread: { id: "original-linq-chat", isDM: true, post, adapter: { editMessage }, startTyping },
      state: { pendingAuthMessageIds: {} },
    };
    const authorization = {
      displayName: "Link", url: "https://login.link.com/auth?state=opaque-state",
      instructions: "Connect your wallet and return to this chat.",
    };
    const { adapter } = linq as unknown as { adapter: ChannelAdapter };
    const context = new ContextContainer();
    context.set(SessionKey, { sessionId: "original-eve-session" } as never);
    await contextStorage.run(context, async () => {
      await adapter["authorization.required"]!(
        { name: "link", authorization } as never, channel as never,
      );
      expect(post).toHaveBeenCalledExactlyOnceWith({ markdown: expect.stringContaining(authorization.url) });
      expect(channel.state.pendingAuthMessageIds).toEqual({ link: "oauth-message" });
      await adapter["authorization.completed"]!(
        { name: "link", authorization, outcome: "authorized" } as never, channel as never,
      );
    });
    expect(editMessage).toHaveBeenCalledWith("original-linq-chat", "oauth-message", { markdown: "Link connected." });
    expect(startTyping).toHaveBeenCalledWith("Connected. Resuming...");
    expect(channel.state.pendingAuthMessageIds).toEqual({});
  });

  it.each([
    ["missing", { unsigned: true }],
    ["tampered", { tamper: true }],
    ["expired", { age: 600 }],
  ])("rejects a %s signature before dispatch", async (_name, options) => {
    const { response, dispatch } = await deliver(message(), options);
    expect(response.status).toBe(401);
    expect(dispatch).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    ["another line", (event: ReturnType<typeof message>) => { event.data.chat.owner_handle.handle = "+12025550199"; }],
    ["another sender", (event: ReturnType<typeof message>) => { event.data.sender_handle.handle = "+12025550199"; }],
    ["a group chat", (event: ReturnType<typeof message>) => { event.data.chat.is_group = true; }],
    ["a bot echo", (event: ReturnType<typeof message>) => { event.data.sender_handle.is_me = true; }],
    ["an outbound message", (event: ReturnType<typeof message>) => { event.data.direction = "outbound"; }],
    ["an email handle", (event: ReturnType<typeof message>) => { event.data.sender_handle.handle = "demo@example.com"; }],
  ])("ignores a signed message from %s", async (_name, change) => {
    const event = message();
    change(event);
    const { response, dispatch } = await deliver(event);
    expect(response.status).toBe(200);
    expect(dispatch).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    ["BELL_LINQ_ALLOWED_SENDERS", ""],
    ["BELL_LINQ_ALLOWED_SENDERS", `${senderNumber},invalid`],
    ["BELL_LINQ_PHONE_NUMBER", ""],
    ["BELL_LINQ_PHONE_NUMBER", `tel:${receivingNumber}`],
  ])("fails closed when %s is %j", async (key, value) => {
    vi.stubEnv(key, value);
    const { dispatch } = await deliver(message());
    expect(dispatch).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("accepts an exact phone number in a comma-separated list", async () => {
    vi.stubEnv("BELL_LINQ_ALLOWED_SENDERS", ` +12025550199, ${senderNumber} `);
    const { dispatch } = await deliver(message());
    expect(dispatch).toHaveBeenCalledOnce();
  });
});
