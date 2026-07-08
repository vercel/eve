import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ChannelAdapterContext } from "#channel/adapter.js";
import { buildSessionHandle } from "#channel/session.js";
import { type SubagentAdapterState } from "#execution/subagent-adapter.js";
import { ContextContainer } from "#context/container.js";
import { ContinuationTokenKey, SessionIdKey } from "#context/keys.js";
import type { InputRequest } from "#runtime/input/types.js";
import { SUBAGENT_ADAPTER } from "#execution/subagent-adapter.js";

const SUBAGENT_AUTHORIZATION_COMPLETED = SUBAGENT_ADAPTER["authorization.completed"];
const SUBAGENT_AUTHORIZATION_REQUIRED = SUBAGENT_ADAPTER["authorization.required"];
const SUBAGENT_INPUT_REQUESTED = SUBAGENT_ADAPTER["input.requested"];

if (SUBAGENT_AUTHORIZATION_COMPLETED === undefined) {
  throw new Error("SUBAGENT_ADAPTER is missing its authorization.completed handler.");
}

if (SUBAGENT_AUTHORIZATION_REQUIRED === undefined) {
  throw new Error("SUBAGENT_ADAPTER is missing its authorization.required handler.");
}

if (SUBAGENT_INPUT_REQUESTED === undefined) {
  throw new Error("SUBAGENT_ADAPTER is missing its input.requested handler.");
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
    options: [
      { id: "approve", label: "Approve" },
      { id: "deny", label: "Deny" },
    ],
    prompt: "Approve?",
    requestId: "req-1",
  };
}

describe("SUBAGENT_ADAPTER authorization.required handler", () => {
  it("forwards the child's authorization request via resumeHook", async () => {
    resumeHookMock.mockClear();
    const ctx = makeContext();

    await SUBAGENT_AUTHORIZATION_REQUIRED(
      {
        authorization: {
          displayName: "Weather",
          url: "https://idp.example/authorize?redirect_uri=child",
        },
        description: "Sign in to continue.",
        name: "weather",
        sequence: 2,
        stepIndex: 1,
        turnId: "turn-auth",
        webhookUrl: "https://eve.example/eve/v1/connections/weather/callback/child-session:auth",
      },
      ctx,
    );

    expect(resumeHookMock).toHaveBeenCalledTimes(1);
    expect(resumeHookMock).toHaveBeenCalledWith("parent-token", {
      callId: "call-123",
      childContinuationToken: "child-token",
      childSessionId: "child-session",
      event: {
        authorization: {
          displayName: "Weather",
          url: "https://idp.example/authorize?redirect_uri=child",
        },
        description: "Sign in to continue.",
        name: "weather",
        sequence: 2,
        stepIndex: 1,
        turnId: "turn-auth",
        webhookUrl: "https://eve.example/eve/v1/connections/weather/callback/child-session:auth",
      },
      kind: "subagent-authorization-required",
      subagentName: "linear",
    });
  });
});

describe("SUBAGENT_ADAPTER authorization.completed handler", () => {
  it("forwards the child's authorization completion via resumeHook", async () => {
    resumeHookMock.mockClear();
    const ctx = makeContext();

    await SUBAGENT_AUTHORIZATION_COMPLETED(
      {
        authorization: { displayName: "Weather" },
        name: "weather",
        outcome: "authorized",
        sequence: 3,
        stepIndex: 2,
        turnId: "turn-auth",
      },
      ctx,
    );

    expect(resumeHookMock).toHaveBeenCalledTimes(1);
    expect(resumeHookMock).toHaveBeenCalledWith("parent-token", {
      callId: "call-123",
      childContinuationToken: "child-token",
      childSessionId: "child-session",
      event: {
        authorization: { displayName: "Weather" },
        name: "weather",
        outcome: "authorized",
        sequence: 3,
        stepIndex: 2,
        turnId: "turn-auth",
      },
      kind: "subagent-authorization-completed",
      subagentName: "linear",
    });
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
      eventKind: "subagent-input-request",
      parentContinuationToken: "parent-token",
      subagentName: "linear",
      error: expect.objectContaining({
        message: expect.stringContaining("parent gone"),
      }),
    });
  });
});
