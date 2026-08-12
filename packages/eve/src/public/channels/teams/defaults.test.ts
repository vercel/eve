import { describe, expect, it, vi } from "vitest";

import type { SessionContext } from "#public/definitions/callback-context.js";
import { defaultEvents } from "#public/channels/teams/defaults.js";
import type { TeamsChannelState, TeamsEventContext } from "#public/channels/teams/teamsChannel.js";

const sessionCtx = {} as SessionContext;

function buildChannelStub(state: Partial<TeamsChannelState> = {}) {
  const post = vi.fn().mockResolvedValue({ id: "act1" });
  const startTyping = vi.fn().mockResolvedValue(undefined);
  const update = vi.fn().mockResolvedValue(undefined);
  const channel = {
    adaptiveCardVersion: "1.5",
    thread: { post, startTyping, update } as Partial<TeamsEventContext["thread"]>,
    state: {
      bot: null,
      channelId: null,
      conversationId: "conv1",
      conversationType: "personal",
      replyToActivityId: null,
      serviceUrl: null,
      teamId: null,
      tenantId: null,
      triggeringUser: null,
      ...state,
    },
  } as TeamsEventContext;
  return { channel, post, startTyping, update };
}

function authRequiredEvent(overrides: { displayName?: string } = {}) {
  return {
    authorization: { url: "https://connect.example.com/a/sca_1", ...overrides },
    description: "Authorization required for notion",
    name: "notion",
    sequence: 0,
    stepIndex: 0,
    turnId: "turn_0",
  };
}

describe("defaultEvents authorization.required", () => {
  it("renders the title-cased connection name when the challenge has no displayName", async () => {
    const { channel, post } = buildChannelStub();

    await defaultEvents["authorization.required"]!(authRequiredEvent(), channel, sessionCtx);

    const message = post.mock.calls[0]?.[0] as { text: string };
    expect(message.text).toContain("Authorization required for Notion.");
    expect(message.text).toContain("https://connect.example.com/a/sca_1");
    expect(channel.state.pendingAuthActivityId).toBe("act1");
  });

  it("renders the challenge displayName instead of the title-cased connection name", async () => {
    const { channel, post } = buildChannelStub();

    await defaultEvents["authorization.required"]!(
      authRequiredEvent({ displayName: "Notion Workspace" }),
      channel,
      sessionCtx,
    );

    const message = post.mock.calls[0]?.[0] as { text: string; attachments: unknown[] };
    expect(message.text).toContain("Authorization required for Notion Workspace.");
    expect(message.text).toContain("https://connect.example.com/a/sca_1");
    expect(JSON.stringify(message.attachments)).toContain("Sign in with Notion Workspace");
  });

  it("keeps the authorization credential out of shared conversations", async () => {
    const { channel, post } = buildChannelStub({ conversationType: "channel" });

    await defaultEvents["authorization.required"]!(authRequiredEvent(), channel, sessionCtx);

    const message = post.mock.calls[0]?.[0] as { text: string; attachments?: unknown[] };
    expect(message.text).toBe(
      "Authorization required for Notion. Open the matching eve session to continue.",
    );
    expect(message.text).not.toContain("https://");
    expect(message.attachments).toBeUndefined();
  });

  it("renders URL-less device instructions and codes in personal chats", async () => {
    const { channel, post } = buildChannelStub();

    await defaultEvents["authorization.required"]!(
      {
        authorization: { instructions: "Open the provider app.", userCode: "ABCD-1234" },
        description: "Connect your account.",
        name: "notion",
        sequence: 0,
        stepIndex: 0,
        turnId: "turn-1",
      },
      channel,
      sessionCtx,
    );

    const message = post.mock.calls[0]?.[0] as { text: string; attachments: unknown[] };
    expect(message.text).toContain("Open the provider app.");
    expect(message.text).toContain("Code: ABCD-1234");
    expect(JSON.stringify(message.attachments)).toContain("ABCD-1234");
  });
});

describe("defaultEvents authorization.completed", () => {
  it("restarts the typing indicator after authorization succeeds", async () => {
    const { channel, startTyping } = buildChannelStub();

    await defaultEvents["authorization.completed"]!(
      { name: "notion", outcome: "authorized", sequence: 1, stepIndex: 0, turnId: "turn_0" },
      channel,
      sessionCtx,
    );

    expect(startTyping).toHaveBeenCalledTimes(1);
  });

  it("renders the challenge displayName in the completion status", async () => {
    const { channel, update } = buildChannelStub({ pendingAuthActivityId: "act1" });

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

    expect(update).toHaveBeenCalledTimes(1);
    expect(update.mock.calls[0]?.[0]).toBe("act1");
    expect(JSON.stringify(update.mock.calls[0]?.[1])).toContain("Notion Workspace connected");
    expect(channel.state.pendingAuthActivityId).toBeNull();
  });

  it("falls back to the title-cased connection name without a displayName", async () => {
    const { channel, update } = buildChannelStub({ pendingAuthActivityId: "act1" });

    await defaultEvents["authorization.completed"]!(
      { name: "notion", outcome: "authorized", sequence: 1, stepIndex: 0, turnId: "turn_0" },
      channel,
      sessionCtx,
    );

    expect(JSON.stringify(update.mock.calls[0]?.[1])).toContain("Notion connected");
  });
});
