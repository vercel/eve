import { describe, expect, it } from "vitest";

import { buildSessionHandle } from "#channel/session.js";
import { ContextContainer } from "#context/container.js";
import { AuthKey, ContinuationTokenKey, InitiatorAuthKey, SessionIdKey } from "#context/keys.js";

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
    expect(session.continuationToken).toBe("slack:C1:T1");
    expect(session.auth.current?.principalId).toBe("U1");
    expect(session.auth.initiator?.principalId).toBe("eve:app");
  });

  it("reflects later writes via getter access", () => {
    const ctx = new ContextContainer();
    const session = buildSessionHandle(ctx);

    expect(session.continuationToken).toBe("");
    ctx.set(ContinuationTokenKey, "slack:C1:T1");
    expect(session.continuationToken).toBe("slack:C1:T1");
  });

  it("namespaces the channel-local token on setContinuationToken", () => {
    const ctx = new ContextContainer();
    ctx.set(ContinuationTokenKey, "slack:C1:");
    const session = buildSessionHandle(ctx);

    session.setContinuationToken("C1:T1");

    expect(ctx.get(ContinuationTokenKey)).toBe("slack:C1:T1");
  });

  it("is idempotent: a redundant setContinuationToken does not write", () => {
    // Authors call setContinuationToken from hot-path event handlers
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

    session.setContinuationToken("C1:T1");
    expect(writeCount).toBe(0);
    expect(ctx.get(ContinuationTokenKey)).toBe("slack:C1:T1");

    session.setContinuationToken("C1:T2");
    expect(writeCount).toBe(1);
    expect(ctx.get(ContinuationTokenKey)).toBe("slack:C1:T2");
  });

  it("throws clearly when no namespaced placeholder token exists", () => {
    const ctx = new ContextContainer();
    const session = buildSessionHandle(ctx);

    expect(() => session.setContinuationToken("C1:T1")).toThrow(/placeholder continuationToken/);
  });
});
