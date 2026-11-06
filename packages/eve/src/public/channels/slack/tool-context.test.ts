import { describe, expect, it, vi } from "vitest";

import { slackChannel, type SlackChannel } from "#public/channels/slack/slackChannel.js";
import { slackToolContext } from "#public/channels/slack/tool-context.js";

function toolContext(metadata: Record<string, unknown> | undefined) {
  return { channel: { kind: "channel:slack" as const, metadata } } as never;
}

describe("slackToolContext", () => {
  it.each([
    ["a session without channel metadata", undefined],
    ["a non-Slack conversation", { chatId: "1" }],
  ])("is null for %s", (_name, metadata) => {
    expect(slackToolContext(toolContext(metadata), slackChannel())).toBeNull();
  });

  it("rejects a channel slackChannel() didn't build", () => {
    expect(() => slackToolContext(toolContext({ channelId: "C1" }), {} as SlackChannel)).toThrow(
      /needs the channel slackChannel\(\) returned/,
    );
  });

  it("describes the conversation and calls Slack with the channel's token and host", async () => {
    const fetch = vi.fn(
      async (_input: string | URL | Request, _init?: RequestInit) =>
        new Response(JSON.stringify({ ok: true }), {
          headers: { "content-type": "application/json" },
        }),
    );
    const slack = slackChannel({
      api: { apiBaseUrl: "https://slack.test/api/", fetch },
      credentials: { botToken: "xoxb-channel" },
    });

    const conversation = slackToolContext(
      toolContext({
        channelId: "C1",
        installationTeamId: "T_INSTALL",
        teamId: "T1",
        threadTs: "1700000000.000001",
        triggeringMessageTs: "1700000000.000002",
      }),
      slack,
    );

    expect(conversation).toMatchObject({
      channelId: "C1",
      codeChannel: false,
      teamId: "T1",
      threadTs: "1700000000.000001",
      triggeringMessageTs: "1700000000.000002",
    });
    await expect(
      conversation?.request("reactions.add", {
        channel: "C1",
        name: "eyes",
        timestamp: "1700000000.000002",
      }),
    ).resolves.toEqual({ ok: true });

    const [url, init] = fetch.mock.calls[0]!;
    expect(String(url)).toBe("https://slack.test/api/reactions.add");
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer xoxb-channel");
  });

  it("reports a code channel with an empty thread", () => {
    const conversation = slackToolContext(
      toolContext({ channelId: "C1", codeChannel: true, threadTs: null }),
      slackChannel(),
    );
    expect(conversation).toMatchObject({ codeChannel: true, threadTs: "" });
  });
});
