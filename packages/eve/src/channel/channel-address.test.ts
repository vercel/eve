import { describe, expect, it, vi } from "vitest";

import { createChannelAddress } from "#channel/channel-address.js";
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
  it.each(["", "x".repeat(257)])(
    "rejects an invalid idempotency key before accepting a delivery",
    async (idempotencyKey) => {
      const runtime = createRuntime();
      const address = createChannelAddress({
        adapter: { kind: "http" },
        channelName: "webhook",
        continuationToken: "thread",
        runtime,
      });
      await expect(
        address.send("Alice asks for a report.", { auth: null, idempotencyKey }),
      ).rejects.toThrow("idempotencyKey");
      expect(runtime.dispatchContinuation).not.toHaveBeenCalled();
      expect(runtime.createSession).not.toHaveBeenCalled();
    },
  );

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
      // Fresh creation inputs, used only if the owner's deployment was retired.
      successor: expect.objectContaining({
        adapter: { kind: "slack" },
        channelName: "slack",
        continuationToken: "slack:C1:T1",
        input: expect.objectContaining({ message: "hello" }),
      }),
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

  it("reports whether create() started the session that owns the address", async () => {
    const history = [{ text: "Earlier", role: "user" as const }];
    const create = async (owners: readonly (string | undefined)[]) => {
      const runtime = createRuntime();
      vi.mocked(runtime.createSession).mockResolvedValue({
        events: new ReadableStream(),
        sessionId: "sess_started",
      });
      for (const owner of owners) {
        vi.mocked(runtime.resolveContinuation).mockResolvedValueOnce(
          owner === undefined ? undefined : { sessionId: owner },
        );
      }
      const address = createChannelAddress({
        adapter: { kind: "http" },
        channelName: "app",
        continuationToken: "conversation:1",
        runtime,
      });
      const result = await address.create({ auth: null, history });
      return { created: result.created, runtime, sessionId: result.session.id };
    };

    const won = await create([undefined, "sess_started"]);
    expect(won).toMatchObject({ created: true, sessionId: "sess_started" });
    expect(won.runtime.createSession).toHaveBeenCalledWith(
      expect.objectContaining({ continuationToken: "app:conversation:1", input: { history } }),
    );

    // A concurrent send() or create() claimed the address first; this run's history never landed.
    await expect(create([undefined, "sess_other"])).resolves.toMatchObject({
      created: false,
      sessionId: "sess_other",
    });

    const owned = await create(["sess_owner"]);
    expect(owned).toMatchObject({ created: false, sessionId: "sess_owner" });
    expect(owned.runtime.createSession).not.toHaveBeenCalled();
  });
});
