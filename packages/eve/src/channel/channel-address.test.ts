import { describe, expect, it, vi } from "vitest";

import { createChannelAddress } from "#channel/channel-address.js";
import {
  attachChannelActivityPresentation,
  getChannelActivityPresentation,
} from "#channel/activity-renderer.js";
import type { Runtime } from "#channel/types.js";

function createRuntime(): Runtime {
  return {
    createSession: vi.fn(),
    dispatchContinuation: vi.fn().mockResolvedValue({ sessionId: "sess_1", status: "accepted" }),
    dispatchSession: vi.fn().mockResolvedValue({ sessionId: "sess_idle", status: "accepted" }),
    getEventStream: vi.fn(),
    getStreamTailIndex: vi.fn(),
    resolveContinuation: vi.fn(),
    waitForSessionReady: vi.fn().mockResolvedValue({ sessionId: "sess_idle" }),
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

  it("creates an idle session without a model delivery", async () => {
    const runtime = createRuntime();
    vi.mocked(runtime.createSession).mockResolvedValue({
      events: new ReadableStream(),
      sessionId: "sess_idle",
    });
    const address = createChannelAddress({
      adapter: { kind: "slack" },
      channelName: "slack",
      continuationToken: "C1:T1",
      runtime,
    });

    const session = await address.create({ auth: null, title: "Private research" });

    expect(session.id).toBe("sess_idle");
    expect(runtime.dispatchContinuation).not.toHaveBeenCalled();
    expect(runtime.waitForSessionReady).toHaveBeenCalledWith("slack:C1:T1");
    await expect(session.send("Research this", { auth: null })).resolves.toEqual({
      sessionId: "sess_idle",
      status: "accepted",
    });
    expect(runtime.dispatchSession).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: "sess_idle" }),
    );
    expect(runtime.createSession).toHaveBeenCalledWith({
      adapter: { kind: "slack" },
      auth: null,
      capabilities: { requestInput: true },
      channelName: "slack",
      continuationToken: "slack:C1:T1",
      initiatorAuth: undefined,
      input: { message: "" },
      mode: "conversation",
      start: "idle",
      title: "Private research",
    });
  });

  it("returns the authoritative owner when the address is already owned", async () => {
    const runtime = createRuntime();
    vi.mocked(runtime.resolveContinuation).mockResolvedValue({ sessionId: "sess_existing" });
    const address = createChannelAddress({
      adapter: { kind: "slack" },
      channelName: "slack",
      continuationToken: "C1:T1",
      runtime,
    });

    await expect(address.create({ auth: null })).resolves.toMatchObject({ id: "sess_existing" });
    expect(runtime.createSession).not.toHaveBeenCalled();
  });

  it("converges concurrent idle creation on the authoritative address owner", async () => {
    const runtime = createRuntime();
    vi.mocked(runtime.resolveContinuation).mockResolvedValue(undefined);
    vi.mocked(runtime.createSession)
      .mockResolvedValueOnce({ events: new ReadableStream(), sessionId: "candidate-1" })
      .mockResolvedValueOnce({ events: new ReadableStream(), sessionId: "candidate-2" });
    vi.mocked(runtime.waitForSessionReady!).mockResolvedValue({ sessionId: "winner" });
    const address = createChannelAddress({
      adapter: { kind: "slack" },
      channelName: "slack",
      continuationToken: "C1:T1",
      runtime,
    });

    const [first, second] = await Promise.all([
      address.create({ auth: null }),
      address.create({ auth: null }),
    ]);

    expect(first.id).toBe("winner");
    expect(second.id).toBe("winner");
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
});
