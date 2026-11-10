import { describe, expect, it, vi } from "vitest";

import type { SignIn } from "#channel/sign-in.js";
import type { InteractionOutcome } from "#public/channels/slack/connections.js";
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
type SlackReply = Record<string, unknown> & { readonly ok: boolean };

/** The parts of a Slack event context the sign-in handlers read. */
function context(input: {
  readonly threadTs: string;
  readonly channelId?: string;
  readonly codeChannel?: boolean;
  /** Overrides Slack's reply to one call; return `undefined` for the default. */
  readonly reply?: (operation: string, body: SlackBody) => SlackReply | undefined;
}) {
  const channelId = input.channelId ?? "C01";
  const state: Record<string, unknown> = {
    channelId,
    codeChannel: input.codeChannel === true,
    slackUsersByPrincipal: { principal_0: "U777", principal_1: "U888" },
    threadTs: input.threadTs || null,
  };
  let sent = 0;
  const request = vi.fn(async (operation: string, body: SlackBody): Promise<SlackReply> => {
    const override = input.reply?.(operation, body);
    if (override !== undefined) return override;
    if (operation === "chat.postMessage" && String(body.channel).startsWith("U")) {
      sent += 1;
      return {
        channel: `D${String(body.channel).slice(1)}`,
        ok: true,
        ts: `1700000000.00020${sent}`,
      };
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
    channelId,
    codeChannel: input.codeChannel === true,
    request,
    teamId: undefined,
    threadTs: input.threadTs,
  };
  // The handlers read only these fields of the full Slack event context.
  const channel = { slack, state, thread } as never;
  return { channel, request, state, thread };
}

type Request = ReturnType<typeof context>["request"];

/** The bodies of the `chat.postMessage` calls that targeted a person's DM. */
function directMessages(request: Request, user = "U777"): SlackBody[] {
  return request.mock.calls
    .filter(([operation, body]) => operation === "chat.postMessage" && body.channel === user)
    .map(([, body]) => body);
}

function calls(request: Request, operation: string): SlackBody[] {
  return request.mock.calls.filter(([name]) => name === operation).map(([, body]) => body);
}

function settled(interactionId: string, outcome: InteractionOutcome) {
  return { interactionId, outcome };
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
      int_0: { channelId: "D777", ts: "1700000000.000201" },
    });
  });

  it("sends one DM when the same sign-in opens again", async () => {
    const { channel, request } = context({ threadTs: "" });

    await showSlackSignIn(signIn, channel);
    await showSlackSignIn(signIn, channel);

    expect(directMessages(request)).toHaveLength(1);
  });

  it("sends a new DM for a later sign-in to the same connection", async () => {
    const later: SignIn = {
      ...signIn,
      interactionId: "int_1",
      url: "https://connect.example.com/authorize/sca_def",
    };
    const { channel, request, state } = context({ threadTs: "" });

    await showSlackSignIn(signIn, channel);
    await showSlackSignIn(later, channel);

    const sent = directMessages(request);
    expect(sent.map((body) => body.text)).toEqual([
      expect.stringContaining("sca_abc"),
      expect.stringContaining("sca_def"),
    ]);

    await settleSlackSignIn(signIn, settled("int_0", "declined"), channel);

    expect(calls(request, "chat.update").map((body) => body.ts)).toEqual(["1700000000.000201"]);
    expect(state.pendingAuthDirectMessages).toEqual({
      int_1: { channelId: "D777", ts: "1700000000.000202" },
    });
  });

  it("sends an approval responder's sign-in to that responder's DM", async () => {
    const responder: SignIn = {
      ...signIn,
      interactionId: "int_2",
      principalId: "principal_1",
      responseId: "resp_0",
    };
    const { channel, request, thread } = context({ threadTs: "" });

    await showSlackSignIn(responder, channel);

    expect(directMessages(request, "U777")).toHaveLength(0);
    expect(directMessages(request, "U888")).toHaveLength(1);
    expect(thread.post).not.toHaveBeenCalled();
  });

  it("doesn't name the conversation when the session is already a DM", async () => {
    const { channel, request } = context({ channelId: "D777", threadTs: "" });

    await showSlackSignIn(signIn, channel);

    const sent = directMessages(request);
    expect(sent).toHaveLength(1);
    expect(JSON.stringify(sent[0]?.blocks)).not.toContain("This is for your request in");
  });

  it("falls back to the channel when the DM can't be sent", async () => {
    const { channel, thread } = context({
      reply: (operation, body) =>
        operation === "chat.postMessage" && body.channel === "U777"
          ? { error: "channel_not_found", ok: false }
          : undefined,
      threadTs: "",
    });

    await showSlackSignIn(signIn, channel);

    expect(thread.post).toHaveBeenCalledWith("Paused: waiting for <@U777> to connect GitHub…");
    expect(thread.postEphemeral).toHaveBeenCalledOnce();
  });

  it("keeps the channel quiet when Slack's DM reply has no ts to edit", async () => {
    const { channel, request, state, thread } = context({
      reply: (operation, body) =>
        operation === "chat.postMessage" && body.channel === "U777" ? { ok: true } : undefined,
      threadTs: "",
    });

    await showSlackSignIn(signIn, channel);

    expect(directMessages(request)).toHaveLength(1);
    expect(thread.post).not.toHaveBeenCalled();
    expect(state.pendingAuthDirectMessages).toBeUndefined();
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
  it.each([
    ["accepted", ":white_check_mark: GitHub connected"],
    ["declined", "GitHub sign-in cancelled"],
    ["failed", ":x: GitHub authorization failed"],
  ] as const)("edits the DM prompt in place when the sign-in is %s", async (outcome, text) => {
    const { channel, request, state } = context({ threadTs: "" });
    await showSlackSignIn(signIn, channel);

    await settleSlackSignIn(signIn, settled("int_0", outcome), channel);

    expect(calls(request, "chat.update")).toEqual([
      {
        blocks: [{ text: { text, type: "mrkdwn" }, type: "section" }],
        channel: "D777",
        text,
        ts: "1700000000.000201",
      },
    ]);
    expect(calls(request, "chat.delete")).toHaveLength(0);
    expect(state.pendingAuthDirectMessages).toEqual({});
  });

  it("deletes the DM prompt when Slack refuses the edit", async () => {
    const { channel, request, state } = context({
      reply: (operation) =>
        operation === "chat.update" ? { error: "cant_update_message", ok: false } : undefined,
      threadTs: "",
    });
    await showSlackSignIn(signIn, channel);

    await settleSlackSignIn(signIn, settled("int_0", "accepted"), channel);

    expect(calls(request, "chat.delete")).toEqual([{ channel: "D777", ts: "1700000000.000201" }]);
    expect(state.pendingAuthDirectMessages).toEqual({});
  });
});
