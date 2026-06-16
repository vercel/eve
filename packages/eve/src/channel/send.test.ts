import { describe, expect, it, vi } from "vitest";

import type { ChannelAdapter } from "#channel/adapter.js";
import { createSendFn } from "#channel/send.js";
import type { RunHandle, Runtime } from "#channel/types.js";
import { RuntimeNoActiveSessionError } from "#execution/runtime-errors.js";
import type { HandleMessageStreamEvent } from "#protocol/message.js";

function createMockRunHandle(): RunHandle {
  return {
    continuationToken: "test:token",
    events: new ReadableStream<HandleMessageStreamEvent>(),
    sessionId: "mock-session-id",
  };
}

function createRuntime(deliverError: unknown): Runtime {
  return {
    deliver: vi.fn().mockRejectedValue(deliverError),
    run: vi.fn().mockResolvedValue(createMockRunHandle()),
    getEventStream: vi.fn().mockResolvedValue(new ReadableStream<HandleMessageStreamEvent>()),
  };
}

const ADAPTER: ChannelAdapter = { kind: "channel:test" };

describe("createSendFn", () => {
  it("starts a new session silently when the runtime reports no active session", async () => {
    const noSession = new RuntimeNoActiveSessionError("test:token");
    const runtime = createRuntime(noSession);
    // info/debug → console.log; warn → console.warn. Spy on both.
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const send = createSendFn(runtime, ADAPTER, "test");
    const session = await send("hello", {
      auth: null,
      continuationToken: "token",
    });

    expect(session.id).toBe("mock-session-id");
    expect(runtime.deliver).toHaveBeenCalledTimes(1);
    expect(runtime.run).toHaveBeenCalledTimes(1);
    expect(log).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();

    log.mockRestore();
    warn.mockRestore();
  });

  it("warns and falls back to a new session when delivery fails unexpectedly", async () => {
    const runtime = createRuntime(new Error("boom"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const send = createSendFn(runtime, ADAPTER, "test");
    const session = await send("hello", {
      auth: null,
      continuationToken: "token",
    });

    expect(session.id).toBe("mock-session-id");
    expect(warn).toHaveBeenCalledTimes(1);
    const payload = warn.mock.calls[0]?.[0];
    expect(String(payload)).toContain("deliver failed");

    warn.mockRestore();
  });

  it("rejects inputResponses when no active session exists", async () => {
    const runtime = createRuntime(new RuntimeNoActiveSessionError("test:token"));
    const send = createSendFn(runtime, ADAPTER, "test");

    await expect(
      send(
        {
          inputResponses: [{ requestId: "req-1", text: "yes" }],
        },
        { auth: null, continuationToken: "token" },
      ),
    ).rejects.toThrow(/Cannot deliver inputResponses/);
    expect(runtime.run).not.toHaveBeenCalled();
  });

  it("forwards context through deliver and run payloads", async () => {
    const context = ["thread background"];
    const deliverRuntime: Runtime = {
      deliver: vi.fn().mockResolvedValue({ sessionId: "existing-session-id" }),
      run: vi.fn().mockResolvedValue(createMockRunHandle()),
      getEventStream: vi.fn().mockResolvedValue(new ReadableStream<HandleMessageStreamEvent>()),
    };

    const deliverSend = createSendFn(deliverRuntime, ADAPTER, "test");
    await deliverSend({ message: "hello", context }, { auth: null, continuationToken: "token" });

    expect(deliverRuntime.deliver).toHaveBeenCalledWith({
      auth: null,
      continuationToken: "test:token",
      payload: {
        inputResponses: undefined,
        message: "hello",
        context,
      },
    });
    expect(deliverRuntime.run).not.toHaveBeenCalled();

    const runRuntime = createRuntime(new RuntimeNoActiveSessionError("test:token"));
    const runSend = createSendFn(runRuntime, ADAPTER, "test");
    await runSend({ message: "hello", context }, { auth: null, continuationToken: "token" });

    expect(vi.mocked(runRuntime.run).mock.calls[0]![0].input).toEqual({
      message: "hello",
      context,
    });
  });

  it("forwards outputSchema through deliver and run payloads", async () => {
    const outputSchema = {
      properties: { title: { type: "string" } },
      required: ["title"],
      type: "object",
    } as const;
    const deliverRuntime: Runtime = {
      deliver: vi.fn().mockResolvedValue({ sessionId: "existing-session-id" }),
      run: vi.fn().mockResolvedValue(createMockRunHandle()),
      getEventStream: vi.fn().mockResolvedValue(new ReadableStream<HandleMessageStreamEvent>()),
    };

    const deliverSend = createSendFn(deliverRuntime, ADAPTER, "test");
    await deliverSend(
      { message: "hello", outputSchema },
      { auth: null, continuationToken: "token" },
    );

    expect(deliverRuntime.deliver).toHaveBeenCalledWith({
      auth: null,
      continuationToken: "test:token",
      payload: {
        inputResponses: undefined,
        message: "hello",
        modelContext: undefined,
        outputSchema,
      },
    });

    const runRuntime = createRuntime(new RuntimeNoActiveSessionError("test:token"));
    const runSend = createSendFn(runRuntime, ADAPTER, "test");
    await runSend({ message: "hello", outputSchema }, { auth: null, continuationToken: "token" });

    expect(vi.mocked(runRuntime.run).mock.calls[0]![0].input).toEqual({
      message: "hello",
      outputSchema,
    });
  });

  it("namespaces the channel-local raw token with the channel name", async () => {
    interface State {
      channelId: string;
      threadTs: string;
    }
    const runtime = createRuntime(new RuntimeNoActiveSessionError("test:token"));
    const stateful: ChannelAdapter = {
      kind: "channel:stateful",
      state: { channelId: "C1", threadTs: "T1" },
    };

    const send = createSendFn<State>(runtime, stateful, "stateful");
    await send("hello", {
      auth: null,
      continuationToken: "C1:T1",
      state: { channelId: "C1", threadTs: "T1" },
    });

    expect(runtime.run).toHaveBeenCalledTimes(1);
    expect(vi.mocked(runtime.run).mock.calls[0]![0].continuationToken).toBe("stateful:C1:T1");
  });

  it("seeds adapter state from the send() call so the new session resumes with it", async () => {
    interface State {
      channelId: string;
      threadTs: string;
    }
    const runtime = createRuntime(new RuntimeNoActiveSessionError("test:token"));
    const stateful: ChannelAdapter = {
      kind: "channel:stateful",
      state: { channelId: null, threadTs: null },
    };

    const send = createSendFn<State>(runtime, stateful, "stateful");
    await send("hello", {
      auth: null,
      continuationToken: "C1:T1",
      state: { channelId: "C1", threadTs: "T1" },
    });

    const runInput = vi.mocked(runtime.run).mock.calls[0]![0];
    expect(runInput.adapter.state).toEqual({ channelId: "C1", threadTs: "T1" });
  });
});
