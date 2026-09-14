import { describe, expect, it, vi } from "vitest";

import type { SessionContext } from "#public/definitions/callback-context.js";
import { defaultEvents, defaultInputRequestedHandler } from "#public/channels/slack/defaults.js";
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

function approvalRequest(requestId = "approval-1") {
  return {
    action: {
      callId: "call-1",
      input: { answer: "private draft" },
      kind: "tool-call" as const,
      toolName: "review_answer",
    },
    allowFreeform: false,
    display: "confirmation" as const,
    kind: "tool-approval" as const,
    options: [
      { id: "approve", label: "Approve", style: "primary" as const },
      { id: "cancel", label: "Cancel", style: "danger" as const },
    ],
    prompt: "Approve review_answer?",
    requestId,
  };
}

function questionRequest(requestId = "question-1") {
  return {
    action: {
      callId: "call-1",
      input: { prompt: "Share the result?" },
      kind: "tool-call" as const,
      toolName: "ask_question",
    },
    allowFreeform: false,
    display: "confirmation" as const,
    kind: "question" as const,
    options: [
      { id: "yes", label: "Yes", style: "primary" as const },
      { id: "no", label: "No", style: "danger" as const },
    ],
    prompt: "Share the result?",
    requestId,
  };
}

function buildChannelStub(state: Partial<SlackChannelState> = {}) {
  const postEphemeral = vi.fn().mockResolvedValue({ id: "eph1", raw: { ok: true } });
  const postDirectMessage = vi
    .fn()
    .mockResolvedValue({ id: "dm1", raw: { channel: "D123", ok: true } });
  const post = vi.fn().mockResolvedValue({ id: "ts1", raw: { ok: true } });
  const startTyping = vi.fn().mockResolvedValue(undefined);
  let postedMessages = 0;
  const request = vi.fn(async (operation: string, _body: unknown) => {
    if (operation === "conversations.open") return { channel: { id: "D123" }, ok: true };
    if (operation === "chat.getPermalink") {
      return {
        ok: true,
        permalink: "https://example.slack.com/archives/C123/p111333?thread_ts=111.222&cid=C123",
      };
    }
    if (operation === "chat.postMessage") {
      postedMessages += 1;
      return { ok: true, ts: `dm${postedMessages}` };
    }
    return { ok: true };
  });
  const channel = {
    thread: { postDirectMessage, postEphemeral, post, startTyping } as Partial<
      SlackEventContext["thread"]
    >,
    slack: { channelId: "C123", request, threadTs: "111.222" } as Partial<
      SlackEventContext["slack"]
    >,
    state: {
      channelId: "C123",
      threadTs: "111.222",
      teamId: null,
      ...state,
    },
  } as SlackEventContext;
  return { channel, post, postDirectMessage, postEphemeral, request, startTyping };
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

describe("defaultInputRequestedHandler private input requests", () => {
  it("uses the authored destination for a tool approval", async () => {
    const { channel, post, postDirectMessage } = buildChannelStub();
    const approvalChannel = vi.fn(() => "thread" as const);

    await defaultInputRequestedHandler(approvalChannel)(
      { requests: [approvalRequest()], sequence: 1, stepIndex: 0, turnId: "turn-1" },
      channel,
      sessionCtx,
    );

    expect(approvalChannel).toHaveBeenCalledWith(
      expect.objectContaining({ requestId: "approval-1" }),
      sessionCtx,
    );
    expect(post).toHaveBeenCalled();
    expect(postDirectMessage).not.toHaveBeenCalled();
  });

  it("routes a ctx.ask question through the same destination resolver", async () => {
    const { channel, post, request } = buildChannelStub({ triggeringUserId: "U_REVIEWER" });
    const approvalChannel = vi.fn(() => "direct-message" as const);

    await defaultInputRequestedHandler(approvalChannel)(
      { requests: [questionRequest()], sequence: 1, stepIndex: 0, turnId: "turn-1" },
      channel,
      sessionCtx,
    );

    expect(approvalChannel).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "question", requestId: "question-1" }),
      sessionCtx,
    );
    expect(post).toHaveBeenCalledWith("Waiting on a response from <@U_REVIEWER>…");
    expect(JSON.stringify(request.mock.calls)).toContain("eve_input:route:C123:111.222:question-1");
    expect(channel.state.pendingApprovalCards).toEqual({});
  });

  it("fails closed when no direct-message reviewer can be resolved", async () => {
    const { channel, post, postDirectMessage, postEphemeral } = buildChannelStub();

    await defaultInputRequestedHandler(() => "direct-message")(
      { requests: [approvalRequest()], sequence: 1, stepIndex: 0, turnId: "turn-1" },
      channel,
      sessionCtx,
    );

    expect(post).not.toHaveBeenCalled();
    expect(postDirectMessage).not.toHaveBeenCalled();
    expect(postEphemeral).not.toHaveBeenCalled();
  });

  it("rolls back partial DM delivery without announcing an unusable approval", async () => {
    const { channel, post, request } = buildChannelStub({
      triggeringMessageTs: "111.333",
      triggeringUserId: "U_REVIEWER",
    });
    let postedMessages = 0;
    request.mockImplementation(async (operation: string) => {
      if (operation === "conversations.open") return { channel: { id: "D123" }, ok: true };
      if (operation === "chat.getPermalink") {
        return { ok: true, permalink: "https://example.slack.com/archives/C123/p111333" };
      }
      if (operation === "chat.postMessage") {
        postedMessages += 1;
        return postedMessages < 3
          ? { ok: true, ts: `dm${postedMessages}` }
          : { error: "message_failed", ok: false };
      }
      return { ok: true };
    });

    await expect(
      defaultInputRequestedHandler(() => "direct-message")(
        { requests: [approvalRequest()], sequence: 1, stepIndex: 0, turnId: "turn-1" },
        channel,
        sessionCtx,
      ),
    ).rejects.toThrow("Slack chat.postMessage failed: message_failed");

    expect(post).not.toHaveBeenCalled();
    expect(request).toHaveBeenCalledWith("chat.delete", { channel: "D123", ts: "dm1" });
    expect(request).toHaveBeenCalledWith("chat.delete", { channel: "D123", ts: "dm2" });
    expect(channel.state.pendingApprovalCards).toBeUndefined();
  });

  it("keeps the actionable DM committed when its thread announcement fails", async () => {
    const { channel, post, request } = buildChannelStub({
      triggeringMessageTs: "111.333",
      triggeringUserId: "U_REVIEWER",
    });
    post.mockRejectedValueOnce(new Error("thread unavailable"));

    await expect(
      defaultInputRequestedHandler(() => "direct-message")(
        { requests: [approvalRequest()], sequence: 1, stepIndex: 0, turnId: "turn-1" },
        channel,
        sessionCtx,
      ),
    ).resolves.toBeUndefined();

    expect(
      request.mock.calls.filter(([operation]) => operation === "chat.postMessage"),
    ).toHaveLength(3);
    expect(channel.state.pendingApprovalCards?.["approval-1"]).toMatchObject({
      messageChannelId: "D123",
      messageTs: "dm3",
    });
  });

  it("previews the triggering message and updates the routed DM card after settlement", async () => {
    const { channel, post, postDirectMessage, request } = buildChannelStub({
      triggeringMessageTs: "111.333",
      triggeringUserId: "U_REVIEWER",
    });

    await defaultInputRequestedHandler(() => "direct-message")(
      { requests: [approvalRequest()], sequence: 1, stepIndex: 0, turnId: "turn-1" },
      channel,
      sessionCtx,
    );

    expect(post).toHaveBeenCalledWith("Waiting on approval from <@U_REVIEWER>…");
    expect(postDirectMessage).not.toHaveBeenCalled();
    expect(
      request.mock.calls.filter(([operation]) => operation === "conversations.open"),
    ).toHaveLength(1);
    const directMessages = request.mock.calls.filter(
      ([operation]) => operation === "chat.postMessage",
    );
    expect(directMessages).toHaveLength(3);
    expect(directMessages[0]?.[1]).toMatchObject({
      channel: "D123",
      markdown_text: "https://example.slack.com/archives/C123/p111333?thread_ts=111.222&cid=C123",
      unfurl_links: true,
    });
    expect(JSON.stringify(directMessages[1]?.[1])).toContain("private draft");
    expect(JSON.stringify(directMessages[2]?.[1])).toContain(
      "eve_input:route:C123:111.222:tool-approval:approval-1",
    );
    expect(request).toHaveBeenCalledWith("chat.getPermalink", {
      channel: "C123",
      message_ts: "111.333",
    });
    expect(channel.state.pendingApprovalCards?.["approval-1"]?.messageChannelId).toBe("D123");

    await defaultEvents["approval.settled"]!(
      {
        outcome: "approved",
        requestId: "approval-1",
        responderPrincipalId: "slack:T1:U_REVIEWER",
        sequence: 1,
        stepIndex: 0,
        turnId: "turn-1",
      },
      channel,
      sessionCtx,
    );

    expect(request).toHaveBeenCalledWith(
      "chat.update",
      expect.objectContaining({ channel: "D123", text: "Answered: Approve", ts: "dm3" }),
    );
    const update = request.mock.calls.find(([method]) => method === "chat.update")?.[1] as {
      blocks?: unknown[];
    };
    expect(JSON.stringify(update.blocks)).not.toContain("eve_input:route:");
  });
});

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
        reason: "GitHub write access is required.",
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
      approvalResponderUsers: { "slack:T1:U777": "U777" },
      pendingApprovalCards: {
        "approval-1": {
          messageBlocks: [
            {
              actions: [{ action_id: "eve_input:tool-approval:approval-1:button:1" }],
              body: { text: "Approve?", type: "mrkdwn" },
              type: "card",
            },
          ],
          messageTs: "123.456",
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
    const update = request.mock.calls.find(([method]) => method === "chat.update")?.[1] as {
      blocks?: unknown[];
    };
    expect(JSON.stringify(update.blocks)).toContain("Answered by <@U777>");
    expect(channel.state.pendingApprovalCards).toEqual({});
  });

  it("settles the request when its buttons carry tool-approval metadata", async () => {
    const { channel, request } = buildChannelStub({
      approvalResponderUsers: { "slack:T1:U777": "U777" },
      pendingApprovalCards: {
        "approval-1": {
          messageBlocks: [
            {
              actions: [
                { action_id: "eve_input:tool-approval:approval-1:button:0" },
                { action_id: "eve_input:tool-approval:approval-1:button:1" },
              ],
              body: { text: "Approve?", type: "mrkdwn" },
              type: "card",
            },
          ],
          messageTs: "123.456",
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
    expect(JSON.stringify(update.blocks)).not.toContain("eve_input:tool-approval:approval-1");
  });

  it("keeps earlier grouped cards settled when approvals are answered out of order", async () => {
    const requestIds = Array.from({ length: 5 }, (_, index) => `approval-${index + 1}`);
    const messageBlocks = requestIds.map((requestId) => ({
      actions: [
        { action_id: `eve_input:tool-approval:${requestId}:button:0` },
        { action_id: `eve_input:tool-approval:${requestId}:button:1` },
      ],
      body: { text: `Approve ${requestId}?`, type: "mrkdwn" },
      type: "card",
    }));
    const { channel, request } = buildChannelStub({
      approvalResponderUsers: { "slack:T1:U777": "U777" },
      pendingApprovalCards: Object.fromEntries(
        requestIds.map((requestId) => [requestId, { messageBlocks, messageTs: "123.456" }]),
      ),
    });
    const settlementOrder = ["approval-5", "approval-2", "approval-1"];

    for (const [index, requestId] of settlementOrder.entries()) {
      await defaultEvents["approval.settled"]!(
        {
          outcome: "approved",
          requestId,
          responderPrincipalId: "slack:T1:U777",
          sequence: index + 1,
          stepIndex: index,
          turnId: "turn-1",
        },
        channel,
        sessionCtx,
      );

      const update = request.mock.calls[index]?.[1] as { blocks?: unknown[] };
      const rendered = JSON.stringify(update.blocks);
      for (const settledRequestId of settlementOrder.slice(0, index + 1)) {
        expect(rendered).not.toContain(`eve_input:tool-approval:${settledRequestId}`);
      }
      for (const pendingRequestId of requestIds.filter(
        (candidate) => !settlementOrder.slice(0, index + 1).includes(candidate),
      )) {
        expect(rendered).toContain(`eve_input:tool-approval:${pendingRequestId}`);
      }
    }
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
