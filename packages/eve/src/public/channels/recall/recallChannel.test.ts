import { describe, expect, it, vi } from "vitest";

import { isCompiledChannel } from "#channel/compiled-channel.js";
import { isHttpRouteDefinition } from "#channel/routes.js";
import { readInputText } from "#internal/input-text.js";
import { mockChannelContext } from "#internal/testing/mocks/mock-channel-operations.js";
import { mockAgentRouteArgs } from "#internal/testing/mocks/mock-route-args.js";
import { sendRecallChatMessage } from "#public/channels/recall/api.js";
import { defaultEvents, matchSpokenOption } from "#public/channels/recall/defaults.js";
import {
  recallChannel,
  type RecallChannelConfig,
  type RecallHandle,
} from "#public/channels/recall/recallChannel.js";
import { signRecallWebhook } from "#public/channels/recall/verify.js";

const SECRET = `whsec_${Buffer.from("recall-test-secret").toString("base64")}`;
const participant = { id: 7, is_host: false, name: "Alice", platform: "desktop" };

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
});

/** A channel on a fake Recall API, driven the way a session step drives it. */
function liveChannel(state: Record<string, unknown>) {
  const posts: { message: string; to?: string }[] = [];
  const fetch = vi.fn(async (url: unknown, init?: RequestInit) => {
    if (String(url).endsWith("/bot/") || String(url).endsWith("/bot/bot_1/")) {
      return Response.json({ id: "bot_1", meeting_url: { meeting_id: "1", platform: "zoom" } });
    }
    posts.push(JSON.parse(String(init?.body)) as { message: string; to?: string });
    return new Response("{}");
  });
  const channel = recallChannel({
    api: { fetch: fetch as never },
    credentials: { apiKey: "key", verificationSecret: SECRET },
    webhookUrl: "https://agent.example.com/eve/v1/recall",
  });
  if (!isCompiledChannel(channel)) throw new Error("Expected a compiled channel.");
  // Durable context survives eve restoring channel state after an ignored delivery.
  const durable = new Map<string, unknown>();
  const ctx = {
    get: (key: { name: string }) => durable.get(key.name),
    set: (key: { name: string }, value: unknown) => (durable.set(key.name, value), value),
  };
  const adapterCtx = () =>
    channel.adapter.createAdapterContext!({ ctx, session: {}, state } as never) as {
      recall: RecallHandle;
    };
  return {
    channel,
    posts,
    send: (message: string) => adapterCtx().recall.sendChatMessage(message),
    async hear(payload: string) {
      const { send } = await post(signed(payload));
      const [, delivery] = send.mock.calls[0]!;
      return await channel.adapter.deliver!(
        { context: delivery.context, message: delivery.message, state: delivery.state },
        adapterCtx() as never,
      );
    },
  };
}

const approvalOptions = [
  { id: "approve", label: "Approve" },
  { id: "cancel", label: "Cancel" },
];

describe("recallChannel private replies", () => {
  it("keeps a turn private once a private chat joins it", async () => {
    // A bot eve didn't send learns its platform from Recall, not from participants.
    const meeting = liveChannel({ botId: "bot_1" });

    await meeting.hear(chat("can you deploy v2.4?", "only_bot"));
    await meeting.hear(speech("Eve, use the release branch"));
    await meeting.send("Deploying.");

    expect(meeting.posts).toEqual([{ message: "Deploying.", to: "7" }]);
  });
});

describe("recallChannel spoken answers", () => {
  it.each([
    ["Okay Eve, approve.", "approve"],
    ["Eve, approve it", "approve"],
    ["Eve, one", "approve"],
    ["eve option two please", "cancel"],
    ["let's go with the first", "approve"],
    ["the first one", "approve"],
    ["Eve, the second one", "cancel"],
    ["neither, approve is wrong", undefined],
    ["Eve, what does it deploy?", undefined],
  ])("reads %j as %s", (said, picked) => {
    expect(matchSpokenOption(said, "eve", approvalOptions)?.id).toBe(picked);
  });

  it("answers the prompt on screen with what a natural reply picks", async () => {
    const meeting = liveChannel({
      botId: "bot_1",
      platform: "zoom",
      shownOptions: { options: approvalOptions, requestId: "req_1" },
      shownPromptId: "req_1",
    });

    const input = (await meeting.hear(speech("Okay Eve, approve it."))) ?? undefined;

    expect(readInputText(input)).toBe("approve");
  });
});

describe("recallChannel receive", () => {
  async function received() {
    const state: Record<string, unknown> = {};
    const meeting = liveChannel(state);
    const sent = vi.fn().mockResolvedValue({ id: "session" });
    await meeting.channel.receive!(
      {
        auth: null,
        message: "Join and take notes.",
        target: { meetingUrl: "https://zoom.us/j/1" },
      },
      { from: () => ({ send: sent }) } as never,
    );
    Object.assign(state, structuredClone(sent.mock.calls[0]![1].state));
    return { meeting, state };
  }

  it("holds chat until the bot it sent hears the meeting, then posts it", async () => {
    const { meeting } = await received();

    await meeting.send("On it.");
    expect(meeting.posts).toEqual([]);

    // A line the bot doesn't answer still shows it's in the call.
    await meeting.hear(speech("the login page times out"));
    expect(meeting.posts).toEqual([{ message: "On it." }]);
  });

  it("posts held chat once while a held turn ignores what people say", async () => {
    const { meeting, state } = await received();
    await meeting.send("Deploy release v2.4 to production?");

    // eve ignores each overheard line while the turn waits on its approval,
    // and restores the channel state it had before the line.
    for (const line of ["the staging numbers look fine", "let's wait for Bob"]) {
      const before = structuredClone(state);
      expect(await meeting.hear(speech(line))).toBeUndefined();
      for (const key of Object.keys(state)) delete state[key];
      Object.assign(state, before);
    }
    // The restored state still holds chat, so the next reply queues behind the posted one.
    await meeting.send("Deployed.");
    await meeting.hear(speech("sounds good"));

    expect(meeting.posts.map(({ message }) => message)).toEqual([
      "Deploy release v2.4 to production?",
      "Deployed.",
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
