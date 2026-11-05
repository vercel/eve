import { describe, expect, it, vi } from "vitest";

import type { SignIn } from "#channel/sign-in.js";
import { settleSlackSignIn, showSlackSignIn } from "#public/channels/slack/defaults.js";

const signIn: SignIn = {
  displayName: "GitHub",
  interactionId: "int_0",
  name: "github",
  principalId: "principal_0",
  turnId: "turn_0",
  url: "https://connect.example.com/authorize/sca_abc",
};

type SlackBody = Record<string, unknown>;

/** The parts of a Slack event context the sign-in handlers read. */
function context(input: {
  readonly threadTs: string;
  readonly codeChannel?: boolean;
  readonly failDirectMessage?: boolean;
}) {
  const state: Record<string, unknown> = {
    channelId: "C01",
    codeChannel: input.codeChannel === true,
    slackUsersByPrincipal: { principal_0: "U777" },
    threadTs: input.threadTs || null,
  };
  const request = vi.fn(async (operation: string, body: SlackBody) => {
    if (operation === "chat.postMessage" && body.channel === "U777") {
      return input.failDirectMessage
        ? { error: "channel_not_found", ok: false }
        : { channel: "D777", ok: true, ts: "1700000000.000200" };
    }
    return { ok: true };
  });
  const thread = {
    post: vi.fn(async (_message: string) => ({ id: "1700000000.000100", raw: { ok: true } })),
    postEphemeral: vi.fn(async (_user: string, _message: SlackBody) => ({
      id: "",
      raw: { ok: true },
    })),
    startTyping: vi.fn(async () => undefined),
  };
  const slack = {
    channelId: "C01",
    codeChannel: input.codeChannel === true,
    request,
    teamId: undefined,
    threadTs: input.threadTs,
  };
  // The handlers read only these fields of the full Slack event context.
  const channel = { slack, state, thread } as never;
  return { channel, request, state, thread };
}

/** The bodies of the `chat.postMessage` calls that targeted the person's DM. */
function directMessages(request: ReturnType<typeof context>["request"]): SlackBody[] {
  return request.mock.calls
    .filter(([operation, body]) => operation === "chat.postMessage" && body.channel === "U777")
    .map(([, body]) => body);
}

describe("showSlackSignIn", () => {
  it("sends the prompt to the person's DM when the session has no thread", async () => {
    const { channel, request, state, thread } = context({ threadTs: "" });

    await showSlackSignIn(signIn, channel);

    expect(thread.post).not.toHaveBeenCalled();
    expect(thread.postEphemeral).not.toHaveBeenCalled();
    const sent = directMessages(request);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.text).toContain(signIn.url);
    expect(JSON.stringify(sent[0]?.blocks)).toContain("This is for your request in <#C01>.");
    expect(state.pendingAuthDirectMessages).toEqual({
      github: { channelId: "D777", ts: "1700000000.000200" },
    });
  });

  it("sends one DM when the same sign-in opens again", async () => {
    const { channel, request } = context({ threadTs: "" });

    await showSlackSignIn(signIn, channel);
    await showSlackSignIn(signIn, channel);

    expect(directMessages(request)).toHaveLength(1);
  });

  it("falls back to the channel when the DM can't be sent", async () => {
    const { channel, thread } = context({ failDirectMessage: true, threadTs: "" });

    await showSlackSignIn(signIn, channel);

    expect(thread.post).toHaveBeenCalledWith("Paused: waiting for <@U777> to connect GitHub…");
    expect(thread.postEphemeral).toHaveBeenCalledOnce();
  });

  it("keeps the public status and private prompt in a thread", async () => {
    const { channel, request, thread } = context({ threadTs: "1700000000.000001" });

    await showSlackSignIn(signIn, channel);

    expect(directMessages(request)).toHaveLength(0);
    expect(thread.post).toHaveBeenCalledWith("Paused: waiting for <@U777> to connect GitHub…");
    expect(thread.postEphemeral).toHaveBeenCalledOnce();
  });

  it("keeps the public status and private prompt in a code channel", async () => {
    // A code channel's session has no thread ts, but the channel itself is the conversation.
    const { channel, request, thread } = context({ codeChannel: true, threadTs: "" });

    await showSlackSignIn(signIn, channel);

    expect(directMessages(request)).toHaveLength(0);
    expect(thread.post).toHaveBeenCalledWith("Paused: waiting for <@U777> to connect GitHub…");
    expect(thread.postEphemeral).toHaveBeenCalledOnce();
  });
});

describe("settleSlackSignIn", () => {
  it("edits the DM prompt in place with the outcome", async () => {
    const { channel, request, state } = context({ threadTs: "" });
    await showSlackSignIn(signIn, channel);

    await settleSlackSignIn(signIn, { interactionId: "int_0", outcome: "accepted" }, channel);

    expect(request).toHaveBeenCalledWith("chat.update", {
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
