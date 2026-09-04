import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { callAdapterEventHandler, type ChannelAdapterContext } from "#channel/adapter.js";
import { buildSessionHandle } from "#channel/session.js";
import { type SubagentAdapterState } from "#subagents/adapter-state.js";
import { ContextContainer } from "#context/container.js";
import { ContinuationTokenKey, SessionIdKey } from "#context/keys.js";
import { ChannelKey } from "#runtime/sessions/runtime-context-keys.js";
import type { InputRequest } from "#shared/input.js";
import { SUBAGENT_ADAPTER } from "#subagents/adapter.js";
import { bindTurnCallerContext } from "#subagents/parent-notification.js";

const SUBAGENT_INPUT_REQUESTED = SUBAGENT_ADAPTER["input.requested"];
const SUBAGENT_AUTHORIZATION_REQUIRED = SUBAGENT_ADAPTER["authorization.required"];
const SUBAGENT_AUTHORIZATION_COMPLETED = SUBAGENT_ADAPTER["authorization.completed"];

if (SUBAGENT_INPUT_REQUESTED === undefined) {
  throw new Error("SUBAGENT_ADAPTER is missing its input.requested handler.");
}
if (SUBAGENT_AUTHORIZATION_REQUIRED === undefined) {
  throw new Error("SUBAGENT_ADAPTER is missing its authorization.required handler.");
}
if (SUBAGENT_AUTHORIZATION_COMPLETED === undefined) {
  throw new Error("SUBAGENT_ADAPTER is missing its authorization.completed handler.");
}

const sendSubagentReplyMock = vi.fn();

vi.mock("#subagents/reply.js", () => ({
  sendSubagentReply: (...args: unknown[]) => sendSubagentReplyMock(...args),
}));

function makeContext(): ChannelAdapterContext {
  const ctx = new ContextContainer();
  ctx.set(ContinuationTokenKey, "child-token");
  ctx.set(SessionIdKey, "child-session");
  const state: SubagentAdapterState = {
    callId: "call-123",
    parentReplyTo: { kind: "session", token: "parent-token" },
    parentSessionId: "parent-session",
    subagentName: "linear",
  };
  return {
    ctx,
    state: state as Record<string, unknown>,
    session: buildSessionHandle(ctx),
  };
}

function sampleRequest(): InputRequest {
  return {
    action: {
      callId: "tool-call-1",
      input: {},
      kind: "tool-call",
      toolName: "create_issue",
    },
    kind: "tool-approval",
    options: [
      { id: "approve", label: "Approve" },
      { id: "cancel", label: "Cancel" },
    ],
    prompt: "Approve?",
    requestId: "req-1",
  };
}

const authorization = {
  displayName: "Linear",
  instructions: "Sign in to continue.",
  url: "https://idp.example/authorize",
};

describe("SUBAGENT_ADAPTER authorization handlers", () => {
  it("forwards a required event through each nested subagent adapter hop", async () => {
    sendSubagentReplyMock.mockClear();
    const data = {
      authorization,
      description: "Authorization required for linear",
      name: "linear",
      sequence: 2,
      stepIndex: 3,
      turnId: "turn-auth",
      webhookUrl: "https://eve.example/connections/linear/callback/child-session%3Aauth",
    };

    await callAdapterEventHandler(
      SUBAGENT_ADAPTER,
      { data, type: "authorization.required" },
      makeContext(),
    );

    expect(sendSubagentReplyMock).toHaveBeenCalledWith(
      { kind: "session", token: "parent-token" },
      {
        callId: "call-123",
        childSessionId: "child-session",
        event: { data, type: "authorization.required" },
        kind: "subagent-authorization-event",
        subagentName: "linear",
      },
    );
  });

  it("forwards authorization.completed unchanged via sendSubagentReply", async () => {
    sendSubagentReplyMock.mockClear();
    const data = {
      authorization,
      name: "linear",
      outcome: "authorized" as const,
      sequence: 2,
      stepIndex: 4,
      turnId: "turn-auth",
    };

    await SUBAGENT_AUTHORIZATION_COMPLETED(data, makeContext());

    expect(sendSubagentReplyMock).toHaveBeenCalledWith(
      { kind: "session", token: "parent-token" },
      {
        callId: "call-123",
        childSessionId: "child-session",
        event: { data, type: "authorization.completed" },
        kind: "subagent-authorization-event",
        subagentName: "linear",
      },
    );
  });

  it("skips forwarding when the adapter state is invalid", async () => {
    sendSubagentReplyMock.mockClear();
    const base = makeContext();

    await SUBAGENT_AUTHORIZATION_REQUIRED(
      {
        description: "Authorization required for linear",
        name: "linear",
        sequence: 0,
        stepIndex: 0,
        turnId: "turn-auth",
      },
      { ctx: base.ctx, state: {}, session: base.session },
    );

    expect(sendSubagentReplyMock).not.toHaveBeenCalled();
  });
});

describe("SUBAGENT_ADAPTER input.requested handler", () => {
  it("forwards continuation HITL to the newly bound parent turn", async () => {
    sendSubagentReplyMock.mockClear();
    const rebound = await bindTurnCallerContext({
      caller: {
        callId: "call-continued",
        replyTo: { kind: "session", token: "parent-token-current" },
        subagentName: "linear",
      },
      serializedContext: {
        [ChannelKey.name]: {
          kind: "subagent",
          state: makeContext().state,
        },
      },
    });
    const base = makeContext();
    const channel = rebound[ChannelKey.name] as { readonly state: Record<string, unknown> };

    await SUBAGENT_INPUT_REQUESTED(
      {
        requests: [sampleRequest()],
        sequence: 0,
        stepIndex: 1,
        turnId: "turn-continued",
      },
      { ...base, state: channel.state },
    );

    expect(sendSubagentReplyMock).toHaveBeenCalledWith(
      { kind: "session", token: "parent-token-current" },
      expect.objectContaining({
        callId: "call-continued",
        kind: "subagent-input-request",
      }),
    );
  });

  it("forwards the child's HITL batch via sendSubagentReply", async () => {
    sendSubagentReplyMock.mockClear();
    const ctx = makeContext();

    await SUBAGENT_INPUT_REQUESTED(
      {
        requests: [sampleRequest()],
        sequence: 0,
        stepIndex: 1,
        turnId: "turn-0",
      },
      ctx,
    );

    expect(sendSubagentReplyMock).toHaveBeenCalledTimes(1);
    expect(sendSubagentReplyMock).toHaveBeenCalledWith(
      { kind: "session", token: "parent-token" },
      {
        callId: "call-123",
        childContinuationToken: "child-token",
        childSessionId: "child-session",
        event: {
          requests: [sampleRequest()],
          sequence: 0,
          stepIndex: 1,
          turnId: "turn-0",
        },
        kind: "subagent-input-request",
        subagentName: "linear",
      },
    );
  });

  it("skips forwarding when the adapter state is missing a parent continuation token", async () => {
    sendSubagentReplyMock.mockClear();
    const base = makeContext();
    const ctx: ChannelAdapterContext = {
      ctx: base.ctx,
      state: {},
      session: base.session,
    };

    await SUBAGENT_INPUT_REQUESTED(
      {
        requests: [sampleRequest()],
        sequence: 0,
        stepIndex: 0,
        turnId: "turn-0",
      },
      ctx,
    );

    expect(sendSubagentReplyMock).not.toHaveBeenCalled();
  });
});

describe("SUBAGENT_ADAPTER forward failure logging", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
    warnSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it("warn-logs a structured breadcrumb and rethrows when the parent sendSubagentReply fails", async () => {
    // callAdapterEventHandler swallows the throw to keep the event stream
    // flowing, so the forward site logs the HITL-specific context first.
    sendSubagentReplyMock.mockClear();
    sendSubagentReplyMock.mockImplementationOnce(async () => {
      throw new Error("parent gone");
    });

    const ctx = makeContext();

    await expect(
      SUBAGENT_INPUT_REQUESTED(
        {
          requests: [sampleRequest()],
          sequence: 0,
          stepIndex: 1,
          turnId: "turn-0",
        },
        ctx,
      ),
    ).rejects.toThrow("parent gone");

    const warnCall = warnSpy.mock.calls.find((call: unknown[]) =>
      String(call[0]).startsWith("[eve:execution.subagent-adapter]"),
    );
    expect(warnCall).toBeDefined();
    const [, warnPayload] = warnCall!;
    expect(warnPayload).toMatchObject({
      callId: "call-123",
      childContinuationToken: "child-token",
      childSessionId: "child-session",
      errorId: expect.any(String),
      subagentName: "linear",
      error: expect.objectContaining({
        message: expect.stringContaining("parent gone"),
      }),
    });
  });

  it("includes the authorization event type when auth forwarding fails", async () => {
    sendSubagentReplyMock.mockClear();
    sendSubagentReplyMock.mockRejectedValueOnce(new Error("parent gone"));

    await expect(
      SUBAGENT_AUTHORIZATION_REQUIRED(
        {
          authorization,
          description: "Authorization required for linear",
          name: "linear",
          sequence: 2,
          stepIndex: 3,
          turnId: "turn-auth",
          webhookUrl: "https://eve.example/connections/linear/callback/child-session%3Aauth",
        },
        makeContext(),
      ),
    ).rejects.toThrow("parent gone");

    const warnCall = warnSpy.mock.calls.find((call: unknown[]) =>
      String(call[0]).startsWith("[eve:execution.subagent-adapter]"),
    );
    expect(warnCall?.[1]).toMatchObject({
      callId: "call-123",
      childSessionId: "child-session",
      errorId: expect.any(String),
      eventType: "authorization.required",
      subagentName: "linear",
      error: expect.objectContaining({ message: expect.stringContaining("parent gone") }),
    });
  });
});
