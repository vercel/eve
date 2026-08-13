import { describe, expect, it, vi } from "vitest";

import { createChannelAddress, dispatchOrCreateChannelRoute } from "#channel/channel-address.js";
import { RuntimeSessionOwnershipConflictError } from "#execution/runtime-errors.js";
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
  it("retries a routed command against the winner of a creation race", async () => {
    const runtime = createRuntime();
    vi.mocked(runtime.dispatchContinuation)
      .mockResolvedValueOnce({ status: "session_not_active" })
      .mockResolvedValueOnce({ sessionId: "winner", status: "accepted" });
    vi.mocked(runtime.createSession).mockRejectedValueOnce(
      new RuntimeSessionOwnershipConflictError({
        continuationToken: "slack:C1:T1",
        ownerSessionId: "winner",
        sessionId: "loser",
      }),
    );
    const address = createChannelAddress({
      adapter: { kind: "slack" },
      channelName: "slack",
      continuationToken: "C1:T1",
      runtime,
    });
    const command = {
      auth: null,
      kind: "route-remote" as const,
      message: "hello",
      remote: { description: "Remote", path: "/eve/v1/session", url: "https://example.com" },
      routeId: "remote",
    };

    const session = await dispatchOrCreateChannelRoute({
      address,
      command,
      options: { auth: null },
    });

    expect(session.id).toBe("winner");
    expect(runtime.dispatchContinuation).toHaveBeenCalledTimes(2);
  });

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
