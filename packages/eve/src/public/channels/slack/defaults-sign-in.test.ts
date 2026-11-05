import { describe, expect, it, vi } from "vitest";

import type { SignIn } from "#channel/sign-in.js";
import { settleSlackSignIn, showSlackSignIn } from "#public/channels/slack/defaults.js";
import type { SlackEventContext } from "#public/channels/slack/slackChannel.js";

const signIn: SignIn = {
  displayName: "GitHub",
  interactionId: "int_0",
  name: "github",
  principalId: "principal_0",
  turnId: "turn_0",
  url: "https://connect.example.com/authorize/sca_abc",
};

/** The parts of a Slack event context the sign-in handlers read. */
function context(input: { readonly threadTs: string; readonly failDirectMessage?: boolean }) {
  const state: Record<string, unknown> = {
    channelId: "C01",
    slackUsersByPrincipal: { principal_0: "U777" },
    threadTs: input.threadTs || null,
  };
  const thread = {
    post: vi.fn(async () => ({ id: "1700000000.000100", raw: { ok: true } })),
    postDirectMessage: vi.fn(async () => {
      if (input.failDirectMessage)
        throw new Error("Slack conversations.open failed: missing_scope");
      return { id: "1700000000.000200", raw: { channel: "D777", ok: true } };
    }),
    postEphemeral: vi.fn(async () => ({ id: "", raw: { ok: true } })),
    startTyping: vi.fn(async () => undefined),
  };
  const slack = {
    channelId: "C01",
    codeChannel: false,
    request: vi.fn(async () => ({ ok: true })),
    teamId: undefined,
    threadTs: input.threadTs,
  };
  const channel = { slack, state, thread } as unknown as SlackEventContext;
  return { channel, slack, state, thread };
}

describe("showSlackSignIn", () => {
  it("sends the prompt to the person's DM when the session has no thread", async () => {
    const { channel, state, thread } = context({ threadTs: "" });

    await showSlackSignIn(signIn, channel);

    expect(thread.post).not.toHaveBeenCalled();
    expect(thread.postEphemeral).not.toHaveBeenCalled();
    expect(thread.postDirectMessage).toHaveBeenCalledOnce();
    const [user, message] = thread.postDirectMessage.mock.calls[0] as unknown as [
      string,
      { blocks: { text?: { text: string } }[]; text: string },
    ];
    expect(user).toBe("U777");
    expect(message.text).toContain(signIn.url);
    expect(message.blocks[0]?.text?.text).toContain("This is for your request in <#C01>.");
    expect(state.pendingAuthDirectMessages).toEqual({
      github: { channelId: "D777", ts: "1700000000.000200" },
    });
  });

  it("sends one DM when the same sign-in opens again", async () => {
    const { channel, thread } = context({ threadTs: "" });

    await showSlackSignIn(signIn, channel);
    await showSlackSignIn(signIn, channel);

    expect(thread.postDirectMessage).toHaveBeenCalledOnce();
  });

  it("falls back to the channel when the DM can't be sent", async () => {
    const { channel, thread } = context({ failDirectMessage: true, threadTs: "" });

    await showSlackSignIn(signIn, channel);

    expect(thread.post).toHaveBeenCalledWith("Paused: waiting for <@U777> to connect GitHub…");
    expect(thread.postEphemeral).toHaveBeenCalledOnce();
  });

  it("keeps the public status and private prompt in a thread", async () => {
    const { channel, thread } = context({ threadTs: "1700000000.000001" });

    await showSlackSignIn(signIn, channel);

    expect(thread.postDirectMessage).not.toHaveBeenCalled();
    expect(thread.post).toHaveBeenCalledWith("Paused: waiting for <@U777> to connect GitHub…");
    expect(thread.postEphemeral).toHaveBeenCalledOnce();
  });
});

describe("settleSlackSignIn", () => {
  it("edits the DM prompt in place with the outcome", async () => {
    const { channel, slack, state } = context({ threadTs: "" });
    await showSlackSignIn(signIn, channel);

    await settleSlackSignIn(
      signIn,
      { interactionId: "int_0", outcome: "accepted" } as never,
      channel,
    );

    expect(slack.request).toHaveBeenCalledWith("chat.update", {
      blocks: [
        { text: { text: ":white_check_mark: GitHub connected", type: "mrkdwn" }, type: "section" },
      ],
      channel: "D777",
      text: ":white_check_mark: GitHub connected",
      ts: "1700000000.000200",
    });
    expect(state.pendingAuthDirectMessages).toEqual({});
  });
});
