import { describe, expect, it, vi } from "vitest";

import type { SessionAuthContext } from "#channel/types.js";
import type { SessionContext } from "#public/definitions/callback-context.js";
import { buildSlackAuthContext } from "#public/channels/slack/auth.js";
import { defaultEvents, defaultInputRequestedHandler } from "#public/channels/slack/defaults.js";
import { buildHitlResponderBlockId } from "#public/channels/slack/hitl.js";
import type { SlackChannelState, SlackEventContext } from "#public/channels/slack/slackChannel.js";

function buildSessionContext(current: SessionAuthContext | null): SessionContext {
  return {
    getSandbox: async () => {
      throw new Error("not available in this test");
    },
    getSkill: () => {
      throw new Error("not available in this test");
    },
    session: {
      auth: { current, initiator: current },
      id: "test-session",
      turn: { id: "test-turn", sequence: 0 },
    },
  };
}

const sessionCtx = buildSessionContext(null);

function buildChannelStub(state: Partial<SlackChannelState> = {}) {
  const postEphemeral = vi.fn().mockResolvedValue({ id: "eph1" });
  const post = vi.fn().mockResolvedValue({ id: "ts1" });
  const request = vi.fn().mockResolvedValue({ ok: true });
  const channel = {
    thread: { postEphemeral, post } as Partial<SlackEventContext["thread"]>,
    slack: { channelId: "C123", request } as Partial<SlackEventContext["slack"]>,
    state: {
      channelId: "C123",
      threadTs: "111.222",
      teamId: null,
      ...state,
    },
  } as SlackEventContext;
  return { channel, post, postEphemeral, request };
}

function authRequiredEvent(
  overrides: { url?: string; userCode?: string; displayName?: string } = {},
) {
  return {
    authorization: { url: overrides.url ?? "https://connect.example.com/a/sca_1", ...overrides },
    description: "Authorization required for notion",
    name: "notion",
    sequence: 0,
    stepIndex: 0,
    turnId: "turn_0",
  };
}

function inputRequestedEvent() {
  return {
    requests: [
      {
        action: {
          callId: "call-1",
          input: {},
          kind: "tool-call" as const,
          toolName: "ask",
        },
        prompt: "Question?",
        requestId: "request-1",
      },
    ],
    sequence: 0,
    stepIndex: 0,
    turnId: "turn-1",
  };
}

describe("defaultInputRequestedHandler", () => {
  it("binds each prompt to the current Slack auth instead of channel state", async () => {
    const { channel, post } = buildChannelStub({ triggeringUserId: "U_STALE" });
    const handler = defaultInputRequestedHandler();
    const slackAuth = (userId: string) =>
      buildSlackAuthContext({
        channelId: "C123",
        teamId: "T123",
        threadTs: "111.222",
        userId,
      });

    await handler(inputRequestedEvent(), channel, buildSessionContext(slackAuth("U_FIRST")));
    await handler(inputRequestedEvent(), channel, buildSessionContext(slackAuth("U_SECOND")));

    const blockIds = post.mock.calls.map(([message]) => {
      const blocks = (message as { blocks: Array<{ block_id?: string }> }).blocks;
      return blocks.find((block) => block.block_id !== undefined)?.block_id;
    });
    expect(blockIds).toEqual(
      ["U_FIRST", "U_SECOND"].map((responderUserId) =>
        buildHitlResponderBlockId({ requestId: "request-1", responderUserId }),
      ),
    );
  });

  it("posts a visible diagnostic when the current caller is not Slack-authenticated", async () => {
    const { channel, post } = buildChannelStub({ triggeringUserId: "U_STALE" });
    const current: SessionAuthContext = {
      attributes: { user_id: "U_UNTRUSTED" },
      authenticator: "custom",
      principalId: "app-user-1",
      principalType: "user",
    };

    await defaultInputRequestedHandler()(
      inputRequestedEvent(),
      channel,
      buildSessionContext(current),
    );

    expect(post).toHaveBeenCalledWith(
      "I can't collect this response because the current caller is not authenticated by Slack. Start a new request from Slack to continue.",
    );
  });
});

describe("defaultEvents authorization.required", () => {
  it("posts a public status and delivers the challenge ephemerally to the triggering user", async () => {
    const { channel, post, postEphemeral } = buildChannelStub({ triggeringUserId: "U777" });

    await defaultEvents["authorization.required"]!(authRequiredEvent(), channel, sessionCtx);

    expect(post).toHaveBeenCalledTimes(1);
    const publicText = post.mock.calls[0]?.[0] as string;
    expect(publicText).toBe("Connect with Notion to continue");
    expect(publicText).not.toContain("https://");
    expect(postEphemeral).toHaveBeenCalledTimes(1);
    expect(postEphemeral.mock.calls[0]?.[0]).toBe("U777");
    const message = postEphemeral.mock.calls[0]?.[1] as { text: string; blocks: unknown[] };
    expect(message.text).toContain("https://connect.example.com/a/sca_1");
    expect(channel.state.pendingAuthMessageTs).toEqual({ notion: "ts1" });
  });

  it("renders the device user code in the ephemeral blocks and fallback text", async () => {
    const { channel, postEphemeral } = buildChannelStub({ triggeringUserId: "U777" });

    await defaultEvents["authorization.required"]!(
      authRequiredEvent({ userCode: "OTB-DGO" }),
      channel,
      sessionCtx,
    );

    const message = postEphemeral.mock.calls[0]?.[1] as { text: string; blocks: unknown[] };
    expect(JSON.stringify(message.blocks)).toContain("OTB-DGO");
    expect(message.text).toContain("(code: OTB-DGO)");
  });

  it("renders the challenge displayName instead of the title-cased connection name", async () => {
    const { channel, post, postEphemeral } = buildChannelStub({ triggeringUserId: "U777" });

    await defaultEvents["authorization.required"]!(
      authRequiredEvent({ displayName: "Notion Workspace" }),
      channel,
      sessionCtx,
    );

    expect(post.mock.calls[0]?.[0]).toBe("Connect with Notion Workspace to continue");
    const message = postEphemeral.mock.calls[0]?.[1] as { text: string };
    expect(message.text).toContain("Sign in with Notion Workspace");
  });

  it("posts a link-free public status when there is no triggering user", async () => {
    const { channel, post, postEphemeral } = buildChannelStub({ triggeringUserId: null });

    await defaultEvents["authorization.required"]!(authRequiredEvent(), channel, sessionCtx);

    expect(postEphemeral).not.toHaveBeenCalled();
    expect(post).toHaveBeenCalledTimes(1);
    const publicText = post.mock.calls[0]?.[0] as string;
    expect(publicText).toBe("Authorization required for Notion (no triggering user)");
    expect(publicText).not.toContain("https://");
    expect(channel.state.pendingAuthMessageTs).toEqual({ notion: "ts1" });
  });

  it("keeps the link-free public status when the ephemeral delivery fails", async () => {
    const { channel, post, postEphemeral } = buildChannelStub({ triggeringUserId: "U777" });
    postEphemeral.mockRejectedValueOnce(new Error("ephemeral rejected"));

    await defaultEvents["authorization.required"]!(authRequiredEvent(), channel, sessionCtx);

    expect(post).toHaveBeenCalledTimes(1);
    const publicText = post.mock.calls[0]?.[0] as string;
    expect(publicText).toBe("Connect with Notion to continue");
    expect(publicText).not.toContain("https://");
    expect(channel.state.pendingAuthMessageTs).toEqual({ notion: "ts1" });
  });

  it("reuses an existing public status when authorization is already pending", async () => {
    const { channel, post, postEphemeral } = buildChannelStub({
      triggeringUserId: "U777",
      pendingAuthMessageTs: { notion: "ts0" },
    });

    await defaultEvents["authorization.required"]!(authRequiredEvent(), channel, sessionCtx);

    expect(post).not.toHaveBeenCalled();
    expect(postEphemeral).toHaveBeenCalledTimes(1);
    expect(channel.state.pendingAuthMessageTs).toEqual({ notion: "ts0" });
  });
});

describe("defaultEvents authorization.completed", () => {
  it("edits the public status in place when one was posted", async () => {
    const { channel, postEphemeral, request } = buildChannelStub({
      triggeringUserId: "U777",
      pendingAuthMessageTs: { notion: "ts1" },
    });

    await defaultEvents["authorization.completed"]!(
      { name: "notion", outcome: "authorized", sequence: 1, stepIndex: 0, turnId: "turn_0" },
      channel,
      sessionCtx,
    );

    expect(request).toHaveBeenCalledWith("chat.update", {
      channel: "C123",
      ts: "ts1",
      text: ":white_check_mark: Notion connected",
    });
    expect(postEphemeral).not.toHaveBeenCalled();
    expect(channel.state.pendingAuthMessageTs).toEqual({});
  });

  it("renders the challenge displayName in the completion status", async () => {
    const { channel, request } = buildChannelStub({
      triggeringUserId: "U777",
      pendingAuthMessageTs: { notion: "ts1" },
    });

    await defaultEvents["authorization.completed"]!(
      {
        authorization: { displayName: "Notion Workspace" },
        name: "notion",
        outcome: "authorized",
        sequence: 1,
        stepIndex: 0,
        turnId: "turn_0",
      },
      channel,
      sessionCtx,
    );

    expect(request).toHaveBeenCalledWith("chat.update", {
      channel: "C123",
      ts: "ts1",
      text: ":white_check_mark: Notion Workspace connected",
    });
  });

  it("stays silent when no public status was recorded", async () => {
    const { channel, post, postEphemeral, request } = buildChannelStub({
      triggeringUserId: "U777",
    });

    await defaultEvents["authorization.completed"]!(
      { name: "notion", outcome: "failed", sequence: 1, stepIndex: 0, turnId: "turn_0" },
      channel,
      sessionCtx,
    );

    expect(request).not.toHaveBeenCalled();
    expect(post).not.toHaveBeenCalled();
    expect(postEphemeral).not.toHaveBeenCalled();
  });
});
