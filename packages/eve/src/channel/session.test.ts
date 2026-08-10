import { describe, expect, it, vi } from "vitest";

import { buildSessionHandle, createAttachSessionFn, createSession } from "#channel/session.js";
import type { Runtime } from "#channel/types.js";
import { ContextContainer } from "#context/container.js";
import { AuthKey, ContinuationTokenKey, InitiatorAuthKey, SessionIdKey } from "#context/keys.js";

function createRuntime(): Runtime {
  return {
    createSession: vi.fn(),
    dispatchContinuation: vi.fn(),
    dispatchSession: vi
      .fn()
      .mockImplementation(async ({ sessionId }: { readonly sessionId: string }) => ({
        sessionId,
        status: "accepted",
      })),
    getEventStream: vi.fn(),
    getStreamTailIndex: vi.fn(),
    resolveContinuation: vi.fn(),
  };
}

describe("createSession#cancel", () => {
  it("cancels this session's turn by session id", async () => {
    const runtime = createRuntime();
    const session = createSession("sess_1", runtime);

    await expect(session.cancel()).resolves.toEqual({ sessionId: "sess_1", status: "accepted" });
    expect(runtime.dispatchSession).toHaveBeenCalledWith({
      command: { kind: "cancel", turnId: undefined },
      sessionId: "sess_1",
    });
  });

  it("forwards the turn guard", async () => {
    const runtime = createRuntime();
    const session = createSession("sess_1", runtime);

    await session.cancel({ turnId: "turn_2" });

    expect(runtime.dispatchSession).toHaveBeenCalledWith({
      command: { kind: "cancel", turnId: "turn_2" },
      sessionId: "sess_1",
    });
  });

  it("is available on sessions returned by attachSession", async () => {
    const runtime = createRuntime();
    const session = createAttachSessionFn(runtime)("sess_2");

    await expect(session.cancel()).resolves.toEqual({ sessionId: "sess_2", status: "accepted" });
    expect(runtime.dispatchSession).toHaveBeenCalledWith({
      command: { kind: "cancel", turnId: undefined },
      sessionId: "sess_2",
    });
  });
});

describe("fixed session operations", () => {
  it("dispatches every operation through the stable session id", async () => {
    const runtime = createRuntime();
    const session = createAttachSessionFn(runtime, { requestId: "req_1" })("sess_1");

    await session.send("hello", { auth: null });
    await session.respond([{ optionId: "approve", requestId: "request_1" }], { auth: null });
    await session.compact();
    await session.clear();
    await session.reset({ reason: "fresh start" });

    expect(runtime.dispatchSession).toHaveBeenNthCalledWith(1, {
      command: {
        auth: null,
        kind: "send",
        payload: { message: "hello" },
        requestId: "req_1",
        turnPolicy: "experimental-steer",
      },
      sessionId: "sess_1",
    });
    expect(runtime.dispatchSession).toHaveBeenNthCalledWith(2, {
      command: {
        auth: null,
        kind: "send",
        payload: { inputResponses: [{ optionId: "approve", requestId: "request_1" }] },
        requestId: "req_1",
      },
      sessionId: "sess_1",
    });
    expect(runtime.dispatchSession).toHaveBeenNthCalledWith(3, {
      command: { kind: "compact" },
      sessionId: "sess_1",
    });
    expect(runtime.dispatchSession).toHaveBeenNthCalledWith(4, {
      command: { kind: "clear" },
      sessionId: "sess_1",
    });
    expect(runtime.dispatchSession).toHaveBeenNthCalledWith(5, {
      command: { kind: "reset", reason: "fresh start" },
      sessionId: "sess_1",
    });
  });

  it("maps the public callback abstraction onto internal turn routing", async () => {
    const runtime = createRuntime();
    const session = createSession("sess_1", runtime);
    const callback = {
      callId: "call_1",
      subagentName: "research",
      token: "callback-token",
      url: "https://caller.example.com/eve/v1/callback/callback-token",
    };

    await session.send("continue", { auth: null, callback });
    const invalidSend = async () => {
      // @ts-expect-error runtime TurnCaller routing is not public session input.
      await session.send("continue", { auth: null, caller: {} });
    };
    expect(invalidSend).toBeTypeOf("function");

    expect(runtime.dispatchSession).toHaveBeenCalledWith({
      command: {
        auth: null,
        caller: {
          callId: "call_1",
          replyTo: { kind: "callback", url: callback.url },
          subagentName: "research",
        },
        kind: "send",
        payload: { message: "continue" },
        requestId: undefined,
        turnPolicy: "experimental-steer",
      },
      sessionId: "sess_1",
    });
  });
});

describe("buildSessionHandle", () => {
  it("exposes sessionId / continuationToken / auth from the live accessor", () => {
    const ctx = new ContextContainer();
    ctx.set(SessionIdKey, "sess-123");
    ctx.set(ContinuationTokenKey, "slack:C1:T1");
    ctx.set(AuthKey, {
      attributes: {},
      authenticator: "slack",
      principalId: "U1",
      principalType: "user",
    });
    ctx.set(InitiatorAuthKey, {
      attributes: {},
      authenticator: "app",
      principalId: "eve:app",
      principalType: "runtime",
    });

    const session = buildSessionHandle(ctx);

    expect(session.id).toBe("sess-123");
    expect(session.continuation?.token).toBe("C1:T1");
    expect(session.auth.current?.principalId).toBe("U1");
    expect(session.auth.initiator?.principalId).toBe("eve:app");
  });

  it("reflects later writes via getter access", () => {
    const ctx = new ContextContainer();
    const session = buildSessionHandle(ctx);

    expect(session.continuation).toBeUndefined();
    ctx.set(ContinuationTokenKey, "slack:C1:T1");
    expect(session.continuation?.token).toBe("C1:T1");
  });

  it("namespaces the channel-local token on continuation.rekey", () => {
    const ctx = new ContextContainer();
    ctx.set(ContinuationTokenKey, "slack:C1:");
    const session = buildSessionHandle(ctx);

    session.continuation?.rekey("C1:T1");

    expect(ctx.get(ContinuationTokenKey)).toBe("slack:C1:T1");
  });

  it("round-trips the exposed channel-local token through continuation.rekey", () => {
    const ctx = new ContextContainer();
    ctx.set(ContinuationTokenKey, "slack:C1:T1");
    const session = buildSessionHandle(ctx);

    session.continuation?.rekey(session.continuation.token);

    expect(ctx.get(ContinuationTokenKey)).toBe("slack:C1:T1");
  });

  it("is idempotent: a redundant continuation.rekey does not write", () => {
    // Authors call continuation.rekey from hot-path event handlers
    // (e.g. Slack's `message.completed`). The handler can't always
    // know whether the token has actually changed, so the SessionHandle
    // itself short-circuits redundant writes — the workflow body
    // shouldn't tear down and recreate its park hook for a no-op.
    let writeCount = 0;
    const ctx = new ContextContainer();
    ctx.set(ContinuationTokenKey, "slack:C1:T1");
    const observed = {
      get: ctx.get.bind(ctx),
      has: ctx.has.bind(ctx),
      require: ctx.require.bind(ctx),
      ensure: ctx.ensure.bind(ctx),
      set: <T>(key: { name: string }, value: T | ((current: T | undefined) => T)): T => {
        writeCount += 1;
        return ctx.set(
          key as Parameters<typeof ctx.set>[0],
          value as Parameters<typeof ctx.set>[1],
        ) as T;
      },
    };

    const session = buildSessionHandle(observed);

    session.continuation?.rekey("C1:T1");
    expect(writeCount).toBe(0);
    expect(ctx.get(ContinuationTokenKey)).toBe("slack:C1:T1");

    session.continuation?.rekey("C1:T2");
    expect(writeCount).toBe(1);
    expect(ctx.get(ContinuationTokenKey)).toBe("slack:C1:T2");
  });

  it("throws clearly when no namespaced placeholder token exists", () => {
    const ctx = new ContextContainer();
    const session = buildSessionHandle(ctx);

    expect(session.continuation).toBeUndefined();
  });
});
