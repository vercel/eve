import { describe, expect, it, vi } from "vitest";

import type { ChannelAdapter } from "#channel/adapter.js";
import { createSendFn } from "#channel/send.js";
import type { RunHandle, Runtime, SessionSendCommandResult } from "#channel/types.js";
import {
  RuntimeNoActiveSessionError,
  RuntimeSessionOwnershipConflictError,
} from "#execution/runtime-errors.js";
import type { MessageStreamEvent } from "#protocol/message.js";

function createMockRunHandle(): RunHandle {
  return {
    continuationToken: "test:token",
    events: new ReadableStream<MessageStreamEvent>(),
    sessionId: "mock-session-id",
  };
}

function createRuntime(
  dispatchResult: SessionSendCommandResult = { status: "session_not_active" },
): Runtime {
  return {
    createSession: vi.fn().mockResolvedValue(createMockRunHandle()),
    dispatchContinuation: vi.fn().mockResolvedValue(dispatchResult),
    dispatchSession: vi.fn(),
    getEventStream: vi.fn().mockResolvedValue(new ReadableStream<MessageStreamEvent>()),
    getStreamTailIndex: vi.fn().mockResolvedValue(-1),
    resolveContinuation: vi.fn(),
  };
}

const ADAPTER: ChannelAdapter = { kind: "channel:test" };

describe("createSendFn", () => {
  it("creates a session when the channel address is unowned", async () => {
    const runtime = createRuntime();
    const send = createSendFn(runtime, ADAPTER, "test");

    const session = await send("hello", { auth: null, continuationToken: "token" });

    expect(session.id).toBe("mock-session-id");
    expect(runtime.dispatchContinuation).toHaveBeenCalledWith({
      command: {
        auth: null,
        caller: undefined,
        kind: "send",
        payload: {
          context: undefined,
          inputResponses: undefined,
          message: "hello",
          outputSchema: undefined,
        },
        requestId: undefined,
      },
      continuationToken: "test:token",
    });
    expect(runtime.createSession).toHaveBeenCalledOnce();
  });

  it("rethrows a typed no-active-session error when resume intent forbids fallback", async () => {
    const runtime = createRuntime();

    const send = createSendFn(runtime, ADAPTER, "test");
    await expect(
      send("hello", {
        auth: null,
        continuationToken: "token",
        intent: "resume",
      }),
    ).rejects.toEqual(new RuntimeNoActiveSessionError("test:token"));

    expect(runtime.createSession).not.toHaveBeenCalled();
  });

  it("returns the existing session without creating", async () => {
    const runtime = createRuntime({ sessionId: "existing-session-id", status: "accepted" });
    const send = createSendFn(runtime, ADAPTER, "test");

    await expect(send("hello", { auth: null, continuationToken: "token" })).resolves.toMatchObject({
      id: "existing-session-id",
      continuationToken: "token",
    });
    expect(runtime.createSession).not.toHaveBeenCalled();
  });

  it("propagates unexpected dispatch failures without creating", async () => {
    const failure = new Error("boom");
    const runtime = createRuntime();
    vi.mocked(runtime.dispatchContinuation).mockRejectedValue(failure);

    await expect(
      createSendFn(
        runtime,
        ADAPTER,
        "test",
      )("hello", {
        auth: null,
        continuationToken: "token",
      }),
    ).rejects.toBe(failure);
    expect(runtime.createSession).not.toHaveBeenCalled();
  });

  it("rejects inputResponses when the channel address is unowned", async () => {
    const runtime = createRuntime();

    await expect(
      createSendFn(
        runtime,
        ADAPTER,
        "test",
      )(
        { inputResponses: [{ requestId: "req-1", text: "yes" }] },
        { auth: null, continuationToken: "token" },
      ),
    ).rejects.toThrow(/Cannot deliver inputResponses/);
    expect(runtime.createSession).not.toHaveBeenCalled();
  });

  it("re-dispatches to the winner of a concurrent first-send claim", async () => {
    const runtime = createRuntime();
    vi.mocked(runtime.createSession).mockRejectedValue(
      new RuntimeSessionOwnershipConflictError({
        continuationToken: "test:token",
        ownerSessionId: "winner",
        sessionId: "loser",
      }),
    );
    vi.mocked(runtime.dispatchContinuation)
      .mockResolvedValueOnce({ status: "session_not_active" })
      .mockResolvedValueOnce({ sessionId: "winner", status: "accepted" });

    await expect(
      createSendFn(
        runtime,
        ADAPTER,
        "test",
      )("hello", {
        auth: null,
        continuationToken: "token",
      }),
    ).resolves.toMatchObject({ id: "winner" });
    expect(runtime.dispatchContinuation).toHaveBeenCalledTimes(2);
  });

  it("forwards the turn caller on the session command", async () => {
    const runtime = createRuntime({ sessionId: "existing-session-id", status: "accepted" });
    const caller = {
      callId: "call-1",
      replyTo: { kind: "hook" as const, token: "parent-turn" },
      subagentName: "research",
    };

    await createSendFn(
      runtime,
      ADAPTER,
      "test",
    )({ message: "follow up" }, { auth: null, caller, continuationToken: "token" });

    expect(runtime.dispatchContinuation).toHaveBeenCalledWith({
      command: expect.objectContaining({
        caller,
        payload: expect.not.objectContaining({ caller: expect.anything() }),
      }),
      continuationToken: "test:token",
    });
  });

  it("forwards context, output schema, and request id through dispatch and creation", async () => {
    const runtime = createRuntime();
    const outputSchema = {
      properties: { title: { type: "string" } },
      required: ["title"],
      type: "object",
    } as const;
    const send = createSendFn(runtime, ADAPTER, "test", { requestId: "req_send" });

    await send(
      { context: ["thread background"], message: "hello", outputSchema },
      { auth: null, continuationToken: "token" },
    );

    expect(runtime.dispatchContinuation).toHaveBeenCalledWith({
      command: expect.objectContaining({
        payload: expect.objectContaining({
          context: ["thread background"],
          message: "hello",
          outputSchema,
        }),
        requestId: "req_send",
      }),
      continuationToken: "test:token",
    });
    expect(vi.mocked(runtime.createSession).mock.calls[0]![0]).toEqual(
      expect.objectContaining({
        input: {
          context: ["thread background"],
          message: "hello",
          outputSchema,
        },
        requestId: "req_send",
      }),
    );
  });

  it("namespaces the raw token and seeds state for a new session", async () => {
    interface State {
      channelId: string;
      threadTs: string;
    }
    const runtime = createRuntime();
    const adapter: ChannelAdapter = {
      kind: "channel:stateful",
      state: { channelId: null, threadTs: null },
    };

    await createSendFn<State>(
      runtime,
      adapter,
      "stateful",
    )("hello", {
      auth: null,
      continuationToken: "C1:T1",
      state: { channelId: "C1", threadTs: "T1" },
    });

    const runInput = vi.mocked(runtime.createSession).mock.calls[0]![0];
    expect(runInput.continuationToken).toBe("stateful:C1:T1");
    expect(runInput.adapter.state).toEqual({ channelId: "C1", threadTs: "T1" });
  });

  it("keeps an explicit workflow title separate from the model message", async () => {
    const runtime = createRuntime();
    const message = "<slack_message>ship it</slack_message>";

    await createSendFn(
      runtime,
      ADAPTER,
      "test",
    )(message, {
      auth: null,
      continuationToken: "token",
      title: "ship it",
    });

    const runInput = vi.mocked(runtime.createSession).mock.calls[0]![0];
    expect(runInput.input.message).toBe(message);
    expect(runInput.title).toBe("ship it");
  });
});
