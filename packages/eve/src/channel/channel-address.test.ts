import { describe, expect, it, vi } from "vitest";

import { createChannelAddress } from "#channel/channel-address.js";
import {
  attachAcceptedTraceCoordinates,
  readAcceptedTraceCoordinates,
} from "#channel/session-trace-state.js";
import {
  attachChannelActivityPresentation,
  getChannelActivityPresentation,
} from "#channel/activity-renderer.js";
import type { Runtime } from "#channel/types.js";

function createRuntime(): Runtime {
  return {
    createSession: vi.fn(),
    dispatchContinuation: vi.fn().mockResolvedValue({ sessionId: "sess_1", status: "accepted" }),
    dispatchSession: vi.fn(),
    getEventStream: vi.fn(),
    getStreamTailIndex: vi.fn(),
    resolveContinuation: vi.fn(),
  };
}

describe("createChannelAddress", () => {
  it("rejects channel addresses in the framework-reserved session namespace", () => {
    expect(() =>
      createChannelAddress({
        adapter: { kind: "http" },
        channelName: "eve",
        continuationToken: "session:wrun_1:inbox",
        runtime: createRuntime(),
      }),
    ).toThrow("reserved session namespace");
  });

  it("sends directly through the address and returns a fixed session handle", async () => {
    const runtime = createRuntime();
    const address = createChannelAddress({
      adapter: { kind: "slack" },
      channelName: "slack",
      continuationToken: "C1:T1",
      runtime,
    });

    const session = await address.send("hello", { auth: null });
    await session.clear();

    expect(runtime.dispatchContinuation).toHaveBeenCalledWith({
      command: {
        auth: null,
        kind: "send",
        payload: { message: "hello" },
        requestId: undefined,
        turnPolicy: "steer",
      },
      continuationToken: "slack:C1:T1",
    });
    expect(runtime.resolveContinuation).not.toHaveBeenCalled();
    expect(runtime.createSession).not.toHaveBeenCalled();
    expect(runtime.dispatchSession).toHaveBeenCalledWith({
      command: { kind: "clear" },
      sessionId: "sess_1",
    });
  });

  it("uses the channel policy unless a send overrides it", async () => {
    const runtime = createRuntime();
    const address = createChannelAddress({
      adapter: { kind: "slack" },
      channelName: "slack",
      continuationToken: "C1:T1",
      runtime,
      turnPolicy: "queue",
    });

    await address.send("queued", { auth: null });
    await address.send("replace", { auth: null, turnPolicy: "steer" });
    await address.respond([{ optionId: "yes", requestId: "input-1" }], { auth: null });

    expect(runtime.dispatchContinuation).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ command: expect.objectContaining({ turnPolicy: "queue" }) }),
    );
    expect(runtime.dispatchContinuation).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        command: expect.objectContaining({ turnPolicy: "steer" }),
      }),
    );
    expect(runtime.dispatchContinuation).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({ command: expect.objectContaining({ turnPolicy: undefined }) }),
    );
  });

  it("mints a distinct delivery identity for each channel operation", async () => {
    const runtime = createRuntime();
    const address = createChannelAddress({
      adapter: { kind: "slack" },
      channelName: "slack",
      continuationToken: "C1:T1",
      metadata: {
        channelKind: "channel:slack",
        channelName: "slack",
        requestId: "request-1",
      },
      runtime,
    });

    await address.send("first", { auth: null });
    await address.send("second", { auth: null });

    const calls = vi.mocked(runtime.dispatchContinuation).mock.calls;
    const first = calls[0]?.[0].command;
    const second = calls[1]?.[0].command;
    expect(first?.kind === "send" ? first.delivery : undefined).toMatchObject({
      channelKind: "channel:slack",
      channelName: "slack",
      requestId: "request-1",
    });
    expect(first?.kind === "send" ? first.delivery?.deliveryId : undefined).not.toBe(
      second?.kind === "send" ? second.delivery?.deliveryId : undefined,
    );
  });

  it("enables activity only for a newly created session with configured renderers", async () => {
    const runtime = createRuntime();
    vi.mocked(runtime.dispatchContinuation).mockResolvedValue({ status: "session_not_active" });
    vi.mocked(runtime.createSession).mockResolvedValue({
      events: new ReadableStream(),
      sessionId: "sess_activity",
    });
    const adapter = { kind: "slack" };
    attachChannelActivityPresentation(adapter, {
      destination: () => ({}),
      renderers: [{ id: "status", render: vi.fn() }],
    });
    const address = createChannelAddress<{ channelId: string; threadTs: string }>({
      adapter,
      channelName: "slack",
      continuationToken: "C1:T1",
      runtime,
    });

    await address.send("hello", {
      auth: null,
      state: { channelId: "C1", threadTs: "T1" },
    });

    expect(runtime.createSession).toHaveBeenCalledWith(
      expect.objectContaining({
        adapter: expect.objectContaining({ state: { channelId: "C1", threadTs: "T1" } }),
        capabilities: { requestInput: true },
        continuationConflictCommand: expect.objectContaining({
          kind: "send",
          payload: { message: "hello" },
        }),
      }),
    );
    const created = vi.mocked(runtime.createSession).mock.calls[0]?.[0].adapter;
    expect(created).toBeDefined();
    expect(getChannelActivityPresentation(created!)?.renderers).toEqual([
      expect.objectContaining({ id: "status" }),
    ]);
  });

  it("records the authenticated creator as a new root session's initiator", async () => {
    const runtime = createRuntime();
    vi.mocked(runtime.dispatchContinuation).mockResolvedValue({ status: "session_not_active" });
    vi.mocked(runtime.createSession).mockResolvedValue({
      events: new ReadableStream(),
      sessionId: "sess_root",
    });
    const address = createChannelAddress({
      adapter: { kind: "slack" },
      channelName: "slack",
      continuationToken: "C1:T1",
      runtime,
    });
    const auth = {
      attributes: {},
      authenticator: "slack",
      principalId: "user-1",
      principalType: "user",
    };

    await address.send("hello", { auth });

    expect(runtime.createSession).toHaveBeenCalledWith(
      expect.objectContaining({ auth, initiatorAuth: auth }),
    );
  });

  it("preserves an explicit null initiator on a new root session", async () => {
    const runtime = createRuntime();
    vi.mocked(runtime.dispatchContinuation).mockResolvedValue({ status: "session_not_active" });
    vi.mocked(runtime.createSession).mockResolvedValue({
      events: new ReadableStream(),
      sessionId: "sess_root",
    });
    const address = createChannelAddress({
      adapter: { kind: "slack" },
      channelName: "slack",
      continuationToken: "C1:T1",
      runtime,
    });

    await address.send("hello", {
      auth: {
        attributes: {},
        authenticator: "slack",
        principalId: "user-1",
        principalType: "user",
      },
      initiatorAuth: null,
    });

    expect(runtime.createSession).toHaveBeenCalledWith(
      expect.objectContaining({ initiatorAuth: null }),
    );
  });

  it("uses the transport creator for a legacy delegated session", async () => {
    const runtime = createRuntime();
    vi.mocked(runtime.dispatchContinuation).mockResolvedValue({ status: "session_not_active" });
    vi.mocked(runtime.createSession).mockResolvedValue({
      events: new ReadableStream(),
      sessionId: "sess_child",
    });
    const address = createChannelAddress({
      adapter: { kind: "eve" },
      channelName: "eve",
      continuationToken: "child",
      runtime,
    });

    const auth = {
      attributes: {},
      authenticator: "oidc",
      principalId: "service-1",
      principalType: "service",
    };
    await address.send("hello", {
      auth,
      callback: {
        callId: "call-1",
        subagentName: "research",
        token: "parent",
        url: "https://parent.example/eve/v1/callback/parent",
      },
    });

    expect(runtime.createSession).toHaveBeenCalledWith(
      expect.objectContaining({ auth, initiatorAuth: auth }),
    );
  });

  it("binds every control directly to the namespaced continuation token", async () => {
    const runtime = createRuntime();
    const address = createChannelAddress({
      adapter: { kind: "slack" },
      channelName: "slack",
      continuationToken: "C1:T1",
      runtime,
    });

    await address.cancel({ turnId: "turn_1" });
    await address.compact();
    await address.clear();
    await address.reset({ reason: "fresh start" });

    expect(runtime.dispatchContinuation).toHaveBeenNthCalledWith(1, {
      command: { kind: "cancel", turnId: "turn_1" },
      continuationToken: "slack:C1:T1",
    });
    expect(runtime.dispatchContinuation).toHaveBeenNthCalledWith(2, {
      command: { kind: "compact" },
      continuationToken: "slack:C1:T1",
    });
    expect(runtime.dispatchContinuation).toHaveBeenNthCalledWith(3, {
      command: { kind: "clear" },
      continuationToken: "slack:C1:T1",
    });
    expect(runtime.dispatchContinuation).toHaveBeenNthCalledWith(4, {
      command: { kind: "reset", reason: "fresh start" },
      continuationToken: "slack:C1:T1",
    });
    expect(runtime.resolveContinuation).not.toHaveBeenCalled();
  });

  it("resolves explicitly to a fixed session handle", async () => {
    const runtime = createRuntime();
    vi.mocked(runtime.resolveContinuation).mockResolvedValue({ sessionId: "sess_2" });
    const address = createChannelAddress({
      adapter: { kind: "slack" },
      channelName: "slack",
      continuationToken: "C1:T1",
      runtime,
    });

    const session = await address.resolveSession();
    await session?.clear();

    expect(runtime.resolveContinuation).toHaveBeenCalledWith("slack:C1:T1");
    expect(runtime.dispatchSession).toHaveBeenCalledWith({
      command: { kind: "clear" },
      sessionId: "sess_2",
    });
  });

  it("privately transfers accepted coordinates to the resolved session handle", async () => {
    const runtime = createRuntime();
    const traceCoordinates = {
      spanId: "2".repeat(16),
      traceFlags: 1,
      traceId: "1".repeat(32),
    };
    vi.mocked(runtime.resolveContinuation).mockResolvedValue(
      attachAcceptedTraceCoordinates({ sessionId: "sess_2" }, traceCoordinates),
    );
    const address = createChannelAddress({
      adapter: { kind: "slack" },
      channelName: "slack",
      continuationToken: "C1:T1",
      runtime,
    });

    const session = await address.resolveSession();

    expect(Reflect.ownKeys(session!)).not.toContain("trace");
    expect(readAcceptedTraceCoordinates(session!)).toEqual(traceCoordinates);
  });
});
