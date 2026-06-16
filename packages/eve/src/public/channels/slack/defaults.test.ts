import { describe, expect, it, vi } from "vitest";

import type { SessionContext } from "#public/definitions/callback-context.js";
import { defaultEvents } from "#public/channels/slack/defaults.js";
import type { SlackChannelState, SlackEventContext } from "#public/channels/slack/slackChannel.js";

const sessionCtx = {} as SessionContext;

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

describe("defaultEvents authorization.required", () => {
  it("delivers the challenge ephemerally to the triggering user and posts nothing publicly", async () => {
    const { channel, post, postEphemeral } = buildChannelStub({ triggeringUserId: "U777" });

    await defaultEvents["authorization.required"]!(authRequiredEvent(), channel, sessionCtx);

    expect(postEphemeral).toHaveBeenCalledTimes(1);
    expect(postEphemeral.mock.calls[0]?.[0]).toBe("U777");
    const message = postEphemeral.mock.calls[0]?.[1] as { text: string; blocks: unknown[] };
    expect(message.text).toContain("https://connect.example.com/a/sca_1");
    expect(post).not.toHaveBeenCalled();
    expect(channel.state.pendingAuthMessageTs).toBeUndefined();
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
    const { channel, postEphemeral } = buildChannelStub({ triggeringUserId: "U777" });

    await defaultEvents["authorization.required"]!(
      authRequiredEvent({ displayName: "Notion Workspace" }),
      channel,
      sessionCtx,
    );

    const message = postEphemeral.mock.calls[0]?.[1] as { text: string };
    expect(message.text).toContain("Sign in with Notion Workspace");
  });

  it("falls back to a link-free public status when there is no triggering user", async () => {
    const { channel, post, postEphemeral } = buildChannelStub({ triggeringUserId: null });

    await defaultEvents["authorization.required"]!(authRequiredEvent(), channel, sessionCtx);

    expect(postEphemeral).not.toHaveBeenCalled();
    expect(post).toHaveBeenCalledTimes(1);
    const publicText = post.mock.calls[0]?.[0] as string;
    expect(publicText).toBe("Authorization required for Notion (no triggering user)");
    expect(publicText).not.toContain("https://");
    expect(channel.state.pendingAuthMessageTs).toEqual({ notion: "ts1" });
  });

  it("falls back to a link-free public status when the ephemeral delivery fails", async () => {
    const { channel, post, postEphemeral } = buildChannelStub({ triggeringUserId: "U777" });
    postEphemeral.mockRejectedValueOnce(new Error("ephemeral rejected"));

    await defaultEvents["authorization.required"]!(authRequiredEvent(), channel, sessionCtx);

    expect(post).toHaveBeenCalledTimes(1);
    const publicText = post.mock.calls[0]?.[0] as string;
    expect(publicText).toBe("Connect with Notion to continue");
    expect(publicText).not.toContain("https://");
    expect(channel.state.pendingAuthMessageTs).toEqual({ notion: "ts1" });
  });
});

describe("defaultEvents authorization.completed", () => {
  it("edits the public fallback status in place when one was posted", async () => {
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

  it("stays silent when no fallback status was posted", async () => {
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
