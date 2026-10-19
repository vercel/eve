import { describe, expect, it, vi } from "vitest";

import { isCompiledChannel } from "#channel/compiled-channel.js";
import { isHttpRouteDefinition } from "#channel/routes.js";
import { readInputText } from "#internal/input-text.js";
import { mockChannelContext } from "#internal/testing/mocks/mock-channel-operations.js";
import { mockAgentRouteArgs } from "#internal/testing/mocks/mock-route-args.js";
import { sendRecallChatMessage } from "#public/channels/recall/api.js";
import { defaultEvents } from "#public/channels/recall/defaults.js";
import { recallChannel, type RecallChannelConfig } from "#public/channels/recall/recallChannel.js";
import { signRecallWebhook } from "#public/channels/recall/verify.js";

const SECRET = `whsec_${Buffer.from("recall-test-secret").toString("base64")}`;
const participant = { id: 7, is_host: false, name: "Alice", platform: "zoom" };

function signed(payload: string, extraHeaders: Record<string, string> = {}): Request {
  const timestamp = Math.floor(Date.now() / 1000);
  return new Request("https://agent.example.com/eve/v1/recall", {
    body: payload,
    headers: {
      "webhook-id": "msg_1",
      "webhook-signature": `v1,${signRecallWebhook({ id: "msg_1", payload, secret: SECRET, timestamp })}`,
      "webhook-timestamp": String(timestamp),
      ...extraHeaders,
    },
    method: "POST",
  });
}

function speech(text: string): string {
  return JSON.stringify({
    data: {
      bot: { id: "bot_1", metadata: {} },
      data: { participant, words: text.split(" ").map((word) => ({ text: word })) },
    },
    event: "transcript.data",
  });
}

function chat(text: string, to: string): string {
  return JSON.stringify({
    data: { bot: { id: "bot_1", metadata: {} }, data: { data: { text, to }, participant } },
    event: "participant_events.chat_message",
  });
}

/** Event-handler context with a stubbed chat send that answers `sent` for each call in turn. */
function handlerContext(state: Record<string, unknown>, sent: boolean[] = []) {
  const sendChatMessage = vi.fn(async () => sent.shift() ?? true);
  const recall = {
    botId: "bot_1",
    platform: "zoom",
    sendChatMessage,
    supportsDirectMessages: true,
  };
  return { channel: { recall, state } as never, sendChatMessage };
}

async function post(request: Request, config: RecallChannelConfig = {}) {
  const channel = recallChannel({ credentials: { verificationSecret: SECRET }, ...config });
  if (!isCompiledChannel(channel)) throw new Error("Expected a compiled channel.");
  const route = channel.routes[0];
  if (route === undefined || !isHttpRouteDefinition(route)) throw new Error("Expected a route.");
  const send = vi.fn().mockResolvedValue({ id: "session" });
  const pending: Promise<unknown>[] = [];
  const response = await route.handler(request, {
    ...mockAgentRouteArgs(),
    ...mockChannelContext(send),
    attachSession: vi.fn() as never,
    params: {},
    requestIp: null,
    to: vi.fn() as never,
    waitUntil: (task) => void pending.push(task),
  });
  await Promise.all(pending);
  return { response, send };
}

describe("recallChannel webhook", () => {
  it("answers pending prompts with what a speaker said to the bot, without its name", async () => {
    const { response, send } = await post(signed(speech("Eve, approve.")));

    expect(response.status).toBe(204);
    expect(send).toHaveBeenCalledOnce();
    const [address, delivery] = send.mock.calls[0]!;
    expect(address).toBe("bot_1");
    expect(delivery.message).toBe("Alice: Eve, approve.");
    expect(readInputText(delivery)).toBe("approve");
    expect(delivery.auth.principalId).toBe("recall:bot_1:7");
  });

  it("leaves bot status webhooks out of the session by default", async () => {
    const payload = JSON.stringify({
      data: { bot: { id: "bot_1", metadata: {} }, data: { code: "call_ended" } },
      event: "bot.call_ended",
    });

    const { response, send } = await post(signed(payload));

    expect(response.status).toBe(204);
    expect(send).not.toHaveBeenCalled();
  });

  it("drops the bot's own chat messages", async () => {
    const payload = JSON.stringify({
      data: {
        bot: { id: "bot_1", metadata: {} },
        data: {
          data: { text: "Hi", to: "everyone" },
          participant: { ...participant, name: "Notes" },
        },
      },
      event: "participant_events.chat_message",
    });

    const { send } = await post(signed(payload), { botName: "Notes" });

    expect(send).not.toHaveBeenCalled();
  });

  it.each([
    [
      "an unsigned request",
      new Request("https://agent.example.com/eve/v1/recall", {
        body: speech("Eve hi"),
        method: "POST",
      }),
      401,
    ],
    [
      "a body over the size limit",
      signed(speech("Eve hi"), { "content-length": String(1024 * 1024) }),
      413,
    ],
    // Recall retries any non-2xx every second, so a signed body we can't read is acknowledged.
    ["a signed body that isn't JSON", signed("not json"), 204],
  ])("answers %s with %i and dispatches nothing", async (_name, request, status) => {
    const { response, send } = await post(request);

    expect(response.status).toBe(status);
    expect(send).not.toHaveBeenCalled();
  });

  it("answers 503 with a fix when the verification secret is missing", async () => {
    vi.stubEnv("RECALL_WORKSPACE_VERIFICATION_SECRET", "");
    try {
      const { response } = await post(signed(speech("Eve hi")), { credentials: {} });
      expect(response.status).toBe(503);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe("recallChannel deliver", () => {
  async function deliver(
    channel: ReturnType<typeof recallChannel>,
    state: Record<string, unknown>,
    text: string,
    payload = speech(text),
  ) {
    const { send } = await post(signed(payload));
    const [, delivery] = send.mock.calls[0]!;
    if (!isCompiledChannel(channel)) throw new Error("Expected a compiled channel.");
    return await channel.adapter.deliver!(
      { context: delivery.context, message: delivery.message, state: delivery.state },
      { state } as never,
    );
  }

  it("keeps lines it doesn't answer and hands them to the next turn it takes", async () => {
    const channel = recallChannel({ credentials: { verificationSecret: SECRET } });
    const state: Record<string, unknown> = { botId: "bot_1", platform: "zoom" };

    expect(await deliver(channel, state, "the login page times out")).toBeUndefined();
    const input = await deliver(channel, state, "Eve, file that");

    expect(input?.message).toBe("Alice: Eve, file that");
    expect(input?.context?.at(-1)).toContain("Alice: the login page times out");
    expect(state.transcript).toEqual([]);
  });

  it("asks shouldRespond with the recent transcript, and falls back to name matching if it throws", async () => {
    const seen: (readonly string[])[] = [];
    const answering = recallChannel({
      credentials: { verificationSecret: SECRET },
      shouldRespond: ({ transcript }) => {
        seen.push(transcript);
        return transcript.length > 0;
      },
    });
    const state: Record<string, unknown> = { botId: "bot_1", platform: "zoom" };

    expect(await deliver(answering, state, "who owns the login bug")).toBeUndefined();
    expect(await deliver(answering, state, "can you file it")).toBeDefined();
    expect(seen).toEqual([[], ["Alice: who owns the login bug"]]);

    const failing = recallChannel({
      credentials: { verificationSecret: SECRET },
      shouldRespond: () => {
        throw new Error("decision model unavailable");
      },
    });
    expect(await deliver(failing, {}, "Eve, file it")).toBeDefined();
    expect(await deliver(failing, {}, "moving on")).toBeUndefined();
  });

  it("answers a private chat privately, and a later spoken question in the open", async () => {
    const channel = recallChannel({ credentials: { verificationSecret: SECRET } });
    const state: Record<string, unknown> = { botId: "bot_1", platform: "zoom" };
    const { channel: ctx, sendChatMessage } = handlerContext(state);
    const reply = { message: "The code is 1234." } as never;

    await deliver(channel, state, "", chat("what's the door code?", "only_bot"));
    await defaultEvents["message.completed"]!(reply, ctx, {} as never);
    await deliver(channel, state, "Eve, what's next?");
    await defaultEvents["message.completed"]!(reply, ctx, {} as never);

    expect(sendChatMessage.mock.calls).toEqual([
      ["The code is 1234.", { to: "7" }],
      ["The code is 1234."],
    ]);
  });
});

describe("recall sign-in", () => {
  const required = {
    authorization: { url: "https://auth.example.com/device", userCode: "ABCD" },
    name: "linear",
    principalId: "recall:bot_1:7",
  } as never;

  it("keeps the link out of shared chat when the private send fails", async () => {
    const { channel, sendChatMessage } = handlerContext({}, [false]);

    await defaultEvents["authorization.required"]!(required, channel, {} as never);

    expect(sendChatMessage).toHaveBeenCalledTimes(2);
    const shared = sendChatMessage.mock.calls[1] as unknown[];
    expect(shared).toHaveLength(1);
    expect(shared[0]).toContain("can't deliver a private link");
    expect(shared[0]).not.toContain("ABCD");
  });
});

describe("sendRecallChatMessage", () => {
  it("splits a message at line breaks to fit Google Meet's 500-character chat", async () => {
    const bodies: { message: string }[] = [];
    const fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)) as { message: string });
      return new Response("{}");
    });
    const line = "x".repeat(300);

    await sendRecallChatMessage({
      apiKey: "key",
      botId: "bot_1",
      fetch: fetch as never,
      message: `${line}\n${line}`,
      platform: "google_meet",
    });

    expect(bodies.map(({ message }) => message)).toEqual([line, line]);
  });
});
