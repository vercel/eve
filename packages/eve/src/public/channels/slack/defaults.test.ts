import { describe, expect, it, vi } from "vitest";

import type { SessionContext } from "#public/definitions/callback-context.js";
import { defaultEvents } from "#public/channels/slack/defaults.js";
import type { SlackChannelState, SlackEventContext } from "#public/channels/slack/slackChannel.js";

function sessionContext(
  current: SessionContext["session"]["auth"]["current"] = null,
): SessionContext {
  return {
    getSandbox: vi.fn(),
    getSkill: vi.fn(),
    session: {
      auth: { current, initiator: null },
      id: "test-session",
      turn: { id: "test-turn", sequence: 0 },
    },
  };
}

const sessionCtx = sessionContext();

function buildChannelStub(state: Partial<SlackChannelState> = {}) {
  const postEphemeral = vi.fn().mockResolvedValue({ id: "eph1" });
  const post = vi.fn().mockResolvedValue({ id: "ts1" });
  const startTyping = vi.fn().mockResolvedValue(undefined);
  const request = vi.fn().mockResolvedValue({ ok: true });
  const channel = {
    thread: { postEphemeral, post, startTyping } as Partial<SlackEventContext["thread"]>,
    slack: { channelId: "C123", request } as Partial<SlackEventContext["slack"]>,
    state: {
      channelId: "C123",
      threadTs: "111.222",
      teamId: null,
      ...state,
    },
  } as SlackEventContext;
  return { channel, post, postEphemeral, request, startTyping };
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

describe("defaultEvents approval lifecycle", () => {
  it("sends candidate progress privately", async () => {
    const { channel, postEphemeral } = buildChannelStub({
      pendingApprovalCandidateUsers: { "candidate-1": "U777" },
    });
    const ctx = sessionContext({
      attributes: { user_id: "U777" },
      authenticator: "slack-webhook",
      principalId: "slack:T1:U777",
      principalType: "user",
    });

    await defaultEvents["approval.candidate"]!(
      {
        candidateId: "candidate-1",
        outcome: "pending",
        requestId: "approval-1",
        responderPrincipalId: "slack:T1:U777",
        sequence: 1,
        stepIndex: 0,
        turnId: "turn-1",
      },
      channel,
      ctx,
    );

    expect(postEphemeral).toHaveBeenCalledWith(
      "U777",
      "Checking whether you can approve this action…",
    );
  });

  it("routes candidate progress from event identity instead of ambient auth", async () => {
    const { channel, postEphemeral } = buildChannelStub({
      pendingApprovalCandidateUsers: { "candidate-1": "U777" },
      teamId: "T1",
    });
    const wrongAmbientUser = sessionContext({
      attributes: { user_id: "U_WRONG" },
      authenticator: "slack-webhook",
      principalId: "slack:T1:U_WRONG",
      principalType: "user",
    });

    await defaultEvents["approval.candidate"]!(
      {
        candidateId: "candidate-1",
        outcome: "pending",
        requestId: "approval-1",
        responderPrincipalId: "slack:T1:U777",
        sequence: 1,
        stepIndex: 0,
        turnId: "turn-1",
      },
      channel,
      wrongAmbientUser,
    );

    expect(postEphemeral).toHaveBeenCalledWith(
      "U777",
      "Checking whether you can approve this action…",
    );
    expect(channel.state.pendingApprovalCandidateUsers).toEqual({ "candidate-1": "U777" });
  });

  it("delivers an immediate rejection through the responder mapping", async () => {
    const { channel, postEphemeral } = buildChannelStub({
      pendingApprovalCandidateUsers: { "candidate-1": "U777" },
    });
    const ctx = sessionContext({
      attributes: { user_id: "U777" },
      authenticator: "slack-webhook",
      principalId: "slack:T1:U777",
      principalType: "user",
    });

    await defaultEvents["approval.candidate"]!(
      {
        candidateId: "candidate-1",
        outcome: "rejected",
        requestId: "approval-1",
        responderPrincipalId: "slack:T1:U777",
        safeReason: "GitHub write access is required.",
        sequence: 1,
        stepIndex: 0,
        turnId: "turn-1",
      },
      channel,
      ctx,
    );

    expect(postEphemeral).toHaveBeenCalledWith("U777", "GitHub write access is required.");
  });

  it("updates the shared card only after settlement", async () => {
    const { channel, request } = buildChannelStub({
      pendingApprovalCards: {
        "approval-1": {
          messageBlocks: [
            {
              actions: [{ action_id: "eve_input:approval-1:button:1" }],
              body: { text: "Approve?", type: "mrkdwn" },
              type: "card",
            },
          ],
          messageTs: "123.456",
          userId: "U777",
        },
      },
    });

    await defaultEvents["approval.settled"]!(
      {
        outcome: "approved",
        requestId: "approval-1",
        responderPrincipalId: "slack:T1:U777",
        sequence: 1,
        stepIndex: 0,
        turnId: "turn-1",
      },
      channel,
      sessionCtx,
    );

    expect(request).toHaveBeenCalledWith(
      "chat.update",
      expect.objectContaining({ channel: "C123", text: "Answered: Approve", ts: "123.456" }),
    );
    expect(channel.state.pendingApprovalCards).toEqual({});
  });

  it("settles the request even when the stored click id differs from its sibling button", async () => {
    const { channel, request } = buildChannelStub({
      pendingApprovalCards: {
        "approval-1": {
          messageBlocks: [
            {
              actions: [
                { action_id: "eve_input:approval-1:button:0" },
                { action_id: "eve_input:approval-1:button:1" },
              ],
              body: { text: "Approve?", type: "mrkdwn" },
              type: "card",
            },
          ],
          messageTs: "123.456",
          userId: "U777",
        },
      },
    });

    await defaultEvents["approval.settled"]!(
      {
        outcome: "approved",
        requestId: "approval-1",
        responderPrincipalId: "slack:T1:U777",
        sequence: 1,
        stepIndex: 0,
        turnId: "turn-1",
      },
      channel,
      sessionCtx,
    );

    const update = request.mock.calls.find(([method]) => method === "chat.update")?.[1] as {
      blocks?: unknown[];
    };
    expect(JSON.stringify(update.blocks)).not.toContain("eve_input:approval-1");
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

  it("does not post a public status for candidate-scoped authorization", async () => {
    const { channel, post, postEphemeral } = buildChannelStub({
      pendingApprovalCandidateUsers: { "candidate-1": "U777" },
      triggeringUserId: "U_OTHER",
    });

    await defaultEvents["authorization.required"]!(
      { ...authRequiredEvent(), candidateId: "candidate-1" },
      channel,
      sessionCtx,
    );

    expect(post).not.toHaveBeenCalled();
    expect(postEphemeral).toHaveBeenCalledTimes(1);
  });

  it("uses only the candidate mapping for candidate-scoped challenges", async () => {
    const { channel, postEphemeral } = buildChannelStub({
      pendingApprovalCandidateUsers: { "candidate-1": "U_CANDIDATE" },
      triggeringUserId: "U_STALE",
    });
    const wrongAmbientUser = sessionContext({
      attributes: { user_id: "U_WRONG" },
      authenticator: "slack-webhook",
      principalId: "slack:T01:U_WRONG",
      principalType: "user",
    });

    await defaultEvents["authorization.required"]!(
      { ...authRequiredEvent(), candidateId: "candidate-1" },
      channel,
      wrongAmbientUser,
    );

    expect(postEphemeral.mock.calls[0]?.[0]).toBe("U_CANDIDATE");
  });

  it("does not leak a candidate challenge when its mapping is missing", async () => {
    const { channel, postEphemeral } = buildChannelStub({ triggeringUserId: "U_STALE" });
    await defaultEvents["authorization.required"]!(
      { ...authRequiredEvent(), candidateId: "candidate-missing" },
      channel,
      sessionContext({
        attributes: { user_id: "U_WRONG" },
        authenticator: "slack-webhook",
        principalId: "slack:T01:U_WRONG",
        principalType: "user",
      }),
    );
    expect(postEphemeral).not.toHaveBeenCalled();
  });

  it("targets the current Slack caller instead of stale channel state", async () => {
    const { channel, postEphemeral } = buildChannelStub({ triggeringUserId: "U_FIRST" });
    const currentCaller = sessionContext({
      attributes: { user_id: "U_CURRENT" },
      authenticator: "slack-webhook",
      principalId: "slack:T01:U_CURRENT",
      principalType: "user",
    });

    await defaultEvents["authorization.required"]!(authRequiredEvent(), channel, currentCaller);

    expect(postEphemeral.mock.calls[0]?.[0]).toBe("U_CURRENT");
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
  it("shows that the session is resuming after authorization succeeds", async () => {
    const { channel, startTyping } = buildChannelStub({ triggeringUserId: "U777" });

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

    expect(startTyping).toHaveBeenCalledWith("Connected to Notion Workspace. Resuming...");
  });

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
