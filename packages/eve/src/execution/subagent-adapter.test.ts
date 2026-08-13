import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { callAdapterEventHandler, type ChannelAdapterContext } from "#channel/adapter.js";
import { buildSessionHandle } from "#channel/session.js";
import { type SubagentAdapterState } from "#execution/subagent-adapter-state.js";
import { ContextContainer } from "#context/container.js";
import { ContinuationTokenKey, SessionIdKey } from "#context/keys.js";
import type { RuntimeActionRequest, RuntimeActionResult } from "#runtime/actions/types.js";
import type { InputRequest } from "#runtime/input/types.js";
import { SUBAGENT_ADAPTER } from "#execution/subagent-adapter.js";

const SUBAGENT_INPUT_REQUESTED = SUBAGENT_ADAPTER["input.requested"];
const SUBAGENT_AUTHORIZATION_REQUIRED = SUBAGENT_ADAPTER["authorization.required"];
const SUBAGENT_AUTHORIZATION_COMPLETED = SUBAGENT_ADAPTER["authorization.completed"];
const SUBAGENT_ACTIONS_REQUESTED = SUBAGENT_ADAPTER["actions.requested"];
const SUBAGENT_ACTION_RESULT = SUBAGENT_ADAPTER["action.result"];

if (SUBAGENT_INPUT_REQUESTED === undefined) {
  throw new Error("SUBAGENT_ADAPTER is missing its input.requested handler.");
}
if (SUBAGENT_AUTHORIZATION_REQUIRED === undefined) {
  throw new Error("SUBAGENT_ADAPTER is missing its authorization.required handler.");
}
if (SUBAGENT_AUTHORIZATION_COMPLETED === undefined) {
  throw new Error("SUBAGENT_ADAPTER is missing its authorization.completed handler.");
}
if (SUBAGENT_ACTIONS_REQUESTED === undefined) {
  throw new Error("SUBAGENT_ADAPTER is missing its actions.requested handler.");
}
if (SUBAGENT_ACTION_RESULT === undefined) {
  throw new Error("SUBAGENT_ADAPTER is missing its action.result handler.");
}

const resumeHookMock = vi.fn();

vi.mock("#compiled/@workflow/core/runtime.js", () => ({
  resumeHook: (...args: unknown[]) => resumeHookMock(...args),
}));

function makeContext(): ChannelAdapterContext {
  const ctx = new ContextContainer();
  ctx.set(ContinuationTokenKey, "child-token");
  ctx.set(SessionIdKey, "child-session");
  const state: SubagentAdapterState = {
    callId: "call-123",
    parentContinuationToken: "parent-token",
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

const dispatchAction: RuntimeActionRequest = {
  callId: "call-fetch-sentry",
  description: "Fetch recent Sentry issues",
  input: { message: "What broke today?" },
  kind: "subagent-call",
  name: "fetch_sentry",
  nodeId: "node-1",
  subagentName: "fetch-sentry",
};

const toolCallAction: RuntimeActionRequest = {
  callId: "call-grep",
  input: { pattern: "TODO" },
  kind: "tool-call",
  toolName: "grep",
};

const subagentResult: RuntimeActionResult = {
  callId: "call-fetch-sentry",
  kind: "subagent-result",
  origin: "child",
  outcome: {
    kind: "terminal",
    result: { kind: "succeeded", output: "3 new issues" },
    usageDelta: { cacheReadTokens: 0, cacheWriteTokens: 0, inputTokens: 12, outputTokens: 8 },
  },
  output: "3 new issues",
  subagentName: "fetch-sentry",
};

const toolResult: RuntimeActionResult = {
  callId: "call-grep",
  kind: "tool-result",
  output: "no matches",
  toolName: "grep",
};

describe("SUBAGENT_ADAPTER authorization handlers", () => {
  it("forwards a required event through each nested subagent adapter hop", async () => {
    resumeHookMock.mockClear();
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

    expect(resumeHookMock).toHaveBeenCalledWith("parent-token", {
      callId: "call-123",
      childSessionId: "child-session",
      event: { data, type: "authorization.required" },
      kind: "subagent-forwarded-event",
      subagentName: "linear",
    });
  });

  it("forwards authorization.completed unchanged via resumeHook", async () => {
    resumeHookMock.mockClear();
    const data = {
      authorization,
      name: "linear",
      outcome: "authorized" as const,
      sequence: 2,
      stepIndex: 4,
      turnId: "turn-auth",
    };

    await SUBAGENT_AUTHORIZATION_COMPLETED(data, makeContext());

    expect(resumeHookMock).toHaveBeenCalledWith("parent-token", {
      callId: "call-123",
      childSessionId: "child-session",
      event: { data, type: "authorization.completed" },
      kind: "subagent-forwarded-event",
      subagentName: "linear",
    });
  });

  it("skips forwarding when the adapter state is invalid", async () => {
    resumeHookMock.mockClear();
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

    expect(resumeHookMock).not.toHaveBeenCalled();
  });
});

describe("SUBAGENT_ADAPTER input.requested handler", () => {
  it("forwards the child's HITL batch via resumeHook", async () => {
    resumeHookMock.mockClear();
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

    expect(resumeHookMock).toHaveBeenCalledTimes(1);
    expect(resumeHookMock).toHaveBeenCalledWith("parent-token", {
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
    });
  });

  it("skips forwarding when the adapter state is missing a parent continuation token", async () => {
    resumeHookMock.mockClear();
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

    expect(resumeHookMock).not.toHaveBeenCalled();
  });
});

describe("SUBAGENT_ADAPTER progress handlers", () => {
  it("narrows a mixed batch to the dispatch entries through each adapter hop", async () => {
    resumeHookMock.mockClear();

    await callAdapterEventHandler(
      SUBAGENT_ADAPTER,
      {
        data: {
          actions: [toolCallAction, dispatchAction],
          sequence: 4,
          stepIndex: 2,
          turnId: "child-turn",
        },
        type: "actions.requested",
      },
      makeContext(),
    );

    expect(resumeHookMock).toHaveBeenCalledWith("parent-token", {
      callId: "call-123",
      childSessionId: "child-session",
      event: {
        data: { actions: [dispatchAction], sequence: 4, stepIndex: 2, turnId: "child-turn" },
        type: "actions.requested",
      },
      kind: "subagent-forwarded-event",
      subagentName: "linear",
    });
  });

  it("does not forward a batch of the child's own tool calls", async () => {
    resumeHookMock.mockClear();

    await SUBAGENT_ACTIONS_REQUESTED(
      {
        actions: [toolCallAction],
        sequence: 4,
        stepIndex: 2,
        turnId: "child-turn",
      },
      makeContext(),
    );

    expect(resumeHookMock).not.toHaveBeenCalled();
  });

  it("forwards a settled nested dispatch unchanged via resumeHook", async () => {
    resumeHookMock.mockClear();
    const data = {
      result: subagentResult,
      sequence: 5,
      stepIndex: 2,
      status: "completed" as const,
      turnId: "child-turn",
    };

    await SUBAGENT_ACTION_RESULT(data, makeContext());

    expect(resumeHookMock).toHaveBeenCalledWith("parent-token", {
      callId: "call-123",
      childSessionId: "child-session",
      event: { data, type: "action.result" },
      kind: "subagent-forwarded-event",
      subagentName: "linear",
    });
  });

  it("does not forward the child's own tool results", async () => {
    resumeHookMock.mockClear();

    await SUBAGENT_ACTION_RESULT(
      {
        result: toolResult,
        sequence: 5,
        stepIndex: 2,
        status: "completed",
        turnId: "child-turn",
      },
      makeContext(),
    );

    expect(resumeHookMock).not.toHaveBeenCalled();
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

  it("warn-logs a structured breadcrumb and rethrows when the parent resumeHook fails", async () => {
    // callAdapterEventHandler swallows the throw to keep the event stream
    // flowing, so the forward site logs the HITL-specific context first.
    resumeHookMock.mockClear();
    resumeHookMock.mockImplementationOnce(async () => {
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
      parentContinuationToken: "parent-token",
      subagentName: "linear",
      error: expect.objectContaining({
        message: expect.stringContaining("parent gone"),
      }),
    });
  });

  it("includes the forwarded event type when event forwarding fails", async () => {
    resumeHookMock.mockClear();
    resumeHookMock.mockRejectedValueOnce(new Error("parent gone"));

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
      parentContinuationToken: "parent-token",
      subagentName: "linear",
      error: expect.objectContaining({ message: expect.stringContaining("parent gone") }),
    });
  });
});
