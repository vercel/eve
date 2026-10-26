import { describe, expect, it, vi } from "vitest";

import { isCompiledChannel } from "#channel/compiled-channel.js";
import { createMemoryState } from "#compiled/@chat-adapter/state-memory/index.js";
import type { StateAdapter } from "#compiled/chat/index.js";
import type { MessageSendOptions } from "#channel/session.js";
import { mockChannelContext } from "#internal/testing/mocks/mock-channel-operations.js";
import { chatSdkChannel } from "#public/channels/chat-sdk/index.js";
import { discordChannel } from "#public/channels/discord/discordChannel.js";
import { githubChannel } from "#public/channels/github/githubChannel.js";
import { linearChannel } from "#public/channels/linear/linearChannel.js";
import { slackChannel } from "#public/channels/slack/slackChannel.js";
import { teamsChannel } from "#public/channels/teams/teamsChannel.js";
import { telegramChannel } from "#public/channels/telegram/telegramChannel.js";
import { twilioChannel } from "#public/channels/twilio/twilioChannel.js";

const options = {
  auth: {
    attributes: {},
    authenticator: "app",
    principalId: "eve:app",
    principalType: "runtime",
  },
  context: ["Alice is on call this week."],
  history: [{ role: "user", text: "Alice asked for the rollout plan." }],
  idempotencyKey: "github:delivery-42",
  outputSchema: { type: "object" },
  title: "Rollout plan",
  turnPolicy: "queue",
} satisfies Required<MessageSendOptions>;

const chatSdk = chatSdkChannel({
  adapters: {},
  state: createMemoryState() as StateAdapter,
  userName: "eve",
});

const channels = [
  [
    "chat-sdk",
    chatSdk.channel,
    {
      thread: {
        _type: "chat:Thread",
        adapterName: "test",
        channelId: "test:C01",
        id: "test:C01:1700000000.000001",
        isDM: false,
      },
    },
  ],
  ["discord", discordChannel({ credentials: { botToken: "bot-token" } }), { channelId: "C01" }],
  [
    "github",
    githubChannel({ credentials: { webhookSecret: "secret" } }),
    { issueNumber: 7, owner: "acme", repo: "app", repositoryId: 1 },
  ],
  ["linear", linearChannel(), { agentSessionId: "agent_session_1" }],
  ["slack", slackChannel({ credentials: { botToken: "xoxb-test" } }), { channelId: "C123" }],
  [
    "teams",
    teamsChannel({ credentials: { tokenProvider: () => "token" } }),
    { conversationId: "CONV", serviceUrl: "https://service.example/teams" },
  ],
  ["telegram", telegramChannel({ credentials: { botToken: "bot-token" } }), { chatId: 42 }],
  [
    "twilio",
    twilioChannel({ allowFrom: "*", messaging: { from: "+15557654321" } }),
    { phoneNumber: "+15551234567" },
  ],
] as const;

describe("built-in receive() hooks", () => {
  it.each(channels)(
    "%s passes every send option to from().send()",
    async (_name, channel, target) => {
      if (!isCompiledChannel(channel) || channel.receive === undefined) {
        throw new Error("Expected a compiled channel with receive().");
      }
      const { receive } = channel;
      const send = vi.fn().mockResolvedValue({ id: "session_1" });

      await receive(
        { ...options, message: "Prepare the rollout plan.", target },
        mockChannelContext(send),
      );

      expect(send).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ ...options, message: "Prepare the rollout plan." }),
      );
    },
  );
});

describe("slackChannel().receive", () => {
  it("derives a keyed threadless send's continuation token from its idempotency key", async () => {
    const channel = slackChannel({ credentials: { botToken: "xoxb-test" } });
    if (!isCompiledChannel(channel) || channel.receive === undefined) {
      throw new Error("Expected a compiled channel with receive().");
    }
    const send = vi.fn().mockResolvedValue({ sessionId: "session_1" });
    const keyed = (idempotencyKey: string) => ({
      auth: null,
      idempotencyKey,
      message: "Continue this conversation here.",
      target: { channelId: "D_ALICE" },
    });

    await channel.receive(keyed("fork-1"), mockChannelContext(send));
    await channel.receive(keyed("fork-1"), mockChannelContext(send));
    await channel.receive(keyed("fork-2"), mockChannelContext(send));

    const [first, retry, other] = send.mock.calls.map(([continuationToken]) => continuationToken);
    expect(retry).toBe(first);
    expect(other).not.toBe(first);
  });
});
