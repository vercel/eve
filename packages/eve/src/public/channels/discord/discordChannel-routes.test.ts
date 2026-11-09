import { generateKeyPairSync, sign } from "node:crypto";

import { describe, expect, it, type Mock, vi } from "vitest";

import { isCompiledChannel } from "#channel/compiled-channel.js";
import { INACTIVE_REQUEST_NOTICE } from "#channel/inactive-prompt.js";
import { isHttpRouteDefinition } from "#channel/routes.js";
import { SessionNotActiveError } from "#channel/session-not-active-error.js";
import { captureLogRecords } from "#internal/testing/log-records.js";
import { mockChannelContext } from "#internal/testing/mocks/mock-channel-operations.js";
import { mockAgentRouteArgs } from "#internal/testing/mocks/mock-route-args.js";
import { renderInteractionComponents } from "#public/channels/discord/hitl.js";
import { discordChannel } from "#public/channels/discord/index.js";

const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const publicKeyHex = Buffer.from(publicKey.export({ format: "der", type: "spki" }))
  .subarray(-32)
  .toString("hex");

const customId = (
  renderInteractionComponents({
    call: { callId: "call_1", input: {}, name: "ask_question" },
    interactionId: "call_1",
    request: {
      kind: "question",
      options: [{ id: "approve", label: "Approve" }],
      prompt: "Approve?",
    },
    status: "open",
    stepIndex: 0,
    turnId: "turn_0",
  })[0] as { components: Array<{ custom_id: string }> }
).components[0]!.custom_id;

/** A press of Approve in guild G01, as Discord sends it: the presser on `member`. */
function press(content: string | null = "Approve?"): Request {
  const body = JSON.stringify({
    application_id: "APP1",
    channel_id: "C01",
    data: { component_type: 2, custom_id: customId },
    guild_id: "G01",
    id: "I-U01",
    member: { user: { id: "U01", username: "U01" } },
    message: { content, id: "M01" },
    token: "tok2",
    type: 3,
    version: 1,
  });
  const timestamp = String(Math.floor(Date.now() / 1000));
  return new Request("https://example.com/eve/v1/discord", {
    body,
    headers: {
      "content-type": "application/json",
      "x-signature-ed25519": sign(null, Buffer.from(`${timestamp}${body}`), privateKey).toString(
        "hex",
      ),
      "x-signature-timestamp": timestamp,
    },
    method: "POST",
  });
}

/** Posts `request` to the channel's webhook and drains every task it hands to `waitUntil`. */
async function firePost(
  channel: unknown,
  request: Request,
  send: Mock<(...args: any[]) => any>,
): Promise<void> {
  if (!isCompiledChannel(channel)) throw new Error("Expected a compiled channel.");
  const post = channel.routes.find((route) => route.method === "POST");
  if (!post || !isHttpRouteDefinition(post)) throw new Error("Expected a POST route.");
  const waitUntil = vi.fn();
  await post.handler(request, {
    ...mockAgentRouteArgs(),
    attachSession: vi.fn() as never,
    ...mockChannelContext(send),
    to: vi.fn() as never,
    params: {},
    requestIp: null,
    waitUntil,
  });
  let drained = 0;
  while (drained < waitUntil.mock.calls.length) {
    const pending = waitUntil.mock.calls.slice(drained).map(([task]) => task as Promise<unknown>);
    drained = waitUntil.mock.calls.length;
    await Promise.allSettled(pending);
  }
}

describe("discordChannel press no session takes", () => {
  const notActive = () => vi.fn().mockRejectedValue(new SessionNotActiveError());
  const discordApi = (config: Parameters<typeof discordChannel>[0] = {}) => {
    const fetchMock = vi.fn(async (_url: unknown, _init?: RequestInit) =>
      Response.json({ channel_id: "C01", id: "M02" }),
    );
    return {
      channel: discordChannel({
        api: { fetch: fetchMock as typeof fetch },
        credentials: { applicationId: "APP1", botToken: "bot-token", publicKey: publicKeyHex },
        ...config,
      }),
      calls: () =>
        fetchMock.mock.calls.map(([url, init]) => ({
          body: JSON.parse(String(init?.body)) as unknown,
          method: init?.method,
          url: String(url),
        })),
    };
  };
  const prompt = {
    body: {
      allowed_mentions: { parse: [] },
      components: [],
      content: "Approve?\n\nNo longer active",
    },
    method: "PATCH",
    url: "https://discord.com/api/v10/channels/C01/messages/M01",
  };
  const notice = {
    body: { allowed_mentions: { parse: [] }, content: INACTIVE_REQUEST_NOTICE, flags: 64 },
    method: "POST",
    url: "https://discord.com/api/v10/webhooks/APP1/tok2",
  };

  it("retires the pressed prompt and tells only the presser", async () => {
    captureLogRecords();
    const { channel, calls } = discordApi();

    await firePost(channel, press(), notActive());

    expect(calls()).toEqual([prompt, notice]);
  });

  it("only tells the presser when the press carries no prompt to keep", async () => {
    captureLogRecords();
    const { channel, calls } = discordApi();

    await firePost(channel, press(null), notActive());

    expect(calls()).toEqual([notice]);
  });

  it("leaves the prompt alone when delivery fails for another reason", async () => {
    captureLogRecords();
    const { channel, calls } = discordApi();

    await firePost(channel, press(), vi.fn().mockRejectedValue(new Error("boom")));

    expect(calls()).toEqual([]);
  });

  it("leaves the prompt alone when onAnswers drops the press", async () => {
    captureLogRecords();
    const { channel, calls } = discordApi({ onAnswers: () => null });

    await firePost(channel, press(), notActive());

    expect(calls()).toEqual([]);
  });
});
