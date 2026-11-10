import { describe, expect, it, vi } from "vitest";

import { openCodeChannel } from "#public/channels/slack/open-code-channel.js";
import type { SlackChannel } from "#public/channels/slack/slackChannel.js";

const slack = {} as SlackChannel;

const slackUser = (principalId: string) => ({
  attributes: {},
  authenticator: "slack",
  principalId,
  principalType: "user",
});
const alice = slackUser("U_ALICE");
const bob = slackUser("U_BOB");
const slackThread = { channelId: "C_ORIGIN", threadTs: "1700000000.000001" };

function toolContext(
  metadata: Record<string, unknown> | undefined,
  auth: { readonly current: unknown; readonly sender: unknown } = { current: null, sender: null },
) {
  const send = vi.fn(async () => ({ sessionId: "session_code" }));
  const to = vi.fn(() => ({ send }));
  return {
    ctx: {
      callId: "call_1",
      channel: { kind: "channel:slack", metadata },
      messages: [
        { role: "user" as const, content: "Alice asks why the login test fails." },
        {
          role: "assistant" as const,
          content: [
            { type: "text" as const, text: "Let me look." },
            { type: "tool-call" as const, toolCallId: "t1", toolName: "read_file", input: {} },
          ],
        },
      ],
      session: { auth: { ...auth, initiator: auth.current }, id: "session_thread" },
      to,
    } as never,
    send,
    to,
  };
}

describe("openCodeChannel", () => {
  it.each([
    ["a session without channel metadata", undefined],
    ["a non-Slack conversation", { chatId: "1" }],
  ])("is unavailable for %s", async (_name, metadata) => {
    const { ctx, to } = toolContext(metadata);
    await expect(openCodeChannel(ctx, slack, "Start by reproducing it.")).resolves.toEqual({
      reason: "This conversation is not a Slack message.",
      status: "unavailable",
    });
    expect(to).not.toHaveBeenCalled();
  });

  it("is unavailable inside a code channel", async () => {
    const { ctx } = toolContext({ channelId: "C1", codeChannel: true, threadTs: null });
    await expect(openCodeChannel(ctx, slack, "Start by reproducing it.")).resolves.toEqual({
      reason: "This conversation is already a code channel.",
      status: "unavailable",
    });
  });

  it("is unavailable after someone other than the caller spoke, telling the model to ask the caller", async () => {
    const { ctx, to } = toolContext(slackThread, { current: alice, sender: bob });

    await expect(openCodeChannel(ctx, slack, "Start by reproducing it.")).resolves.toEqual({
      reason: expect.stringContaining(
        "Ask the person whose message started this turn to clearly confirm opening it.",
      ),
      status: "unavailable",
    });
    expect(to).not.toHaveBeenCalled();
  });

  it("opens the channel as the caller when their own message was the last", async () => {
    const { ctx, send } = toolContext(slackThread, {
      current: alice,
      sender: { ...alice, attributes: { team: "T01" } },
    });

    await expect(openCodeChannel(ctx, slack, "Start by reproducing it.")).resolves.toEqual({
      sessionId: "session_code",
      status: "opened",
    });
    expect(send).toHaveBeenCalledWith(
      "Start by reproducing it.",
      expect.objectContaining({ auth: alice }),
    );
  });

  it("opens the channel from the triggering message with the conversation's text as history", async () => {
    const { ctx, send, to } = toolContext({
      channelId: "C_ORIGIN",
      installationTeamId: "T01",
      threadTs: "1700000000.000001",
      triggeringMessageTs: "1700000000.000002",
    });

    await expect(
      openCodeChannel(ctx, slack, "Start by reproducing it.", { name: "Fix the login test" }),
    ).resolves.toEqual({ sessionId: "session_code", status: "opened" });
    expect(to).toHaveBeenCalledWith(slack, {
      channelId: "C_ORIGIN",
      codeChannel: {
        name: "Fix the login test",
        originThreadTs: "1700000000.000001",
        originTs: "1700000000.000002",
      },
      installationTeamId: "T01",
    });
    expect(send).toHaveBeenCalledWith("Start by reproducing it.", {
      auth: null,
      history: [
        { role: "user", text: "Alice asks why the login test fails." },
        { role: "assistant", text: "Let me look." },
      ],
      idempotencyKey: "session_thread:call_1",
    });
  });
});
