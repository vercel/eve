import { describe, expect, it } from "vitest";

import { ContextContainer } from "#context/container.js";
import {
  AuthKey,
  ChannelInstrumentationKey,
  ContinuationTokenKey,
  InitiatorAuthKey,
  SessionIdKey,
} from "#context/keys.js";
import { ChannelKey } from "#runtime/sessions/runtime-context-keys.js";
import { buildResolveContext } from "#context/dynamic-resolve-context.js";

function createCtx(): ContextContainer {
  const ctx = new ContextContainer();
  ctx.set(SessionIdKey, "sess-1");
  ctx.set(AuthKey, null);
  ctx.set(InitiatorAuthKey, null);
  ctx.set(ContinuationTokenKey, "token-1");
  return ctx;
}

describe("buildResolveContext", () => {
  it("includes channel metadata from ChannelInstrumentationKey", () => {
    const ctx = createCtx();
    ctx.set(ChannelKey, { kind: "http" });
    ctx.set(ChannelInstrumentationKey, {
      kind: "channel:slack",
      metadata: { threadTs: "1234.5678", userId: "U123" },
    });

    const resolveCtx = buildResolveContext(ctx, []);

    expect(resolveCtx.channel.metadata).toEqual({
      threadTs: "1234.5678",
      userId: "U123",
    });
  });

  it("sets metadata to undefined when ChannelInstrumentationKey is absent", () => {
    const ctx = createCtx();
    ctx.set(ChannelKey, { kind: "http" });

    const resolveCtx = buildResolveContext(ctx, []);

    expect(resolveCtx.channel.metadata).toBeUndefined();
  });

  it("sets metadata to empty object when projection has no metadata", () => {
    const ctx = createCtx();
    ctx.set(ChannelKey, { kind: "http" });
    ctx.set(ChannelInstrumentationKey, {
      kind: "http",
      metadata: {},
    });

    const resolveCtx = buildResolveContext(ctx, []);

    expect(resolveCtx.channel.metadata).toEqual({});
  });
});
