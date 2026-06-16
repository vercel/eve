import { describe, expect, it, vi } from "vitest";

import {
  callDiscordApi,
  discordContinuationToken,
  sendDiscordChannelMessage,
  splitDiscordMessageContent,
  triggerDiscordTypingIndicator,
} from "#public/channels/discord/api.js";

describe("discordContinuationToken", () => {
  it("builds a channel-local token from channel and conversation ids", () => {
    expect(discordContinuationToken("C01", "M01")).toBe("C01:M01");
    expect(discordContinuationToken("C01", undefined)).toBe("C01:");
  });
});

describe("splitDiscordMessageContent", () => {
  it("keeps short content intact", () => {
    expect(splitDiscordMessageContent("hello")).toEqual(["hello"]);
  });

  it("splits long content at Discord's 2000-character cap", () => {
    const chunks = splitDiscordMessageContent(`${"a".repeat(1990)}\n${"b".repeat(30)}`);

    expect(chunks).toHaveLength(2);
    expect(chunks[0]!.length).toBeLessThanOrEqual(2000);
    expect(chunks[1]).toBe("b".repeat(30));
  });
});

describe("callDiscordApi", () => {
  it("posts JSON with optional bot auth", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ id: "M01" }), {
        headers: { "content-type": "application/json" },
      }),
    );

    await callDiscordApi({
      apiBaseUrl: "https://discord.test/api/v10",
      body: { content: "hello" },
      botToken: "bot-token",
      fetch: fetchMock,
      path: "/channels/C01/messages",
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe("https://discord.test/api/v10/channels/C01/messages");
    expect(new Headers((init as RequestInit).headers).get("authorization")).toBe("Bot bot-token");
    expect(JSON.parse(String((init as RequestInit).body))).toEqual({ content: "hello" });
  });
});

describe("sendDiscordChannelMessage", () => {
  it("suppresses allowed mentions by default", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ channel_id: "C01", id: "M01" }), {
        headers: { "content-type": "application/json" },
      }),
    );

    const posted = await sendDiscordChannelMessage({
      apiBaseUrl: "https://discord.test/api/v10",
      body: { content: "hello @everyone" },
      channelId: "C01",
      credentials: { botToken: "bot-token" },
      fetch: fetchMock,
    });

    expect(posted).toEqual({
      channelId: "C01",
      id: "M01",
      raw: { channel_id: "C01", id: "M01" },
    });
    const [, init] = fetchMock.mock.calls[0]!;
    expect(JSON.parse(String((init as RequestInit).body))).toMatchObject({
      allowed_mentions: { parse: [] },
      content: "hello @everyone",
    });
  });
});

describe("triggerDiscordTypingIndicator", () => {
  it("posts to Discord's typing endpoint with bot auth", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));

    await triggerDiscordTypingIndicator({
      apiBaseUrl: "https://discord.test/api/v10",
      channelId: "C01",
      credentials: { botToken: "bot-token" },
      fetch: fetchMock,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe("https://discord.test/api/v10/channels/C01/typing");
    expect(new Headers((init as RequestInit).headers).get("authorization")).toBe("Bot bot-token");
    expect((init as RequestInit).method).toBe("POST");
    expect((init as RequestInit).body).toBeUndefined();
  });
});
