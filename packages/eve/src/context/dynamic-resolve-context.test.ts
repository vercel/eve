import { describe, expect, it } from "vitest";

import { ContextContainer } from "#context/container.js";
import {
  StaticModelReferenceKey,
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
  ctx.set(StaticModelReferenceKey, { id: "openai/gpt-5.5" });
  ctx.set(SessionIdKey, "sess-1");
  ctx.set(AuthKey, null);
  ctx.set(InitiatorAuthKey, null);
  ctx.set(ContinuationTokenKey, "token-1");
  return ctx;
}

describe("buildResolveContext", () => {
  it("includes the active agent model", () => {
    const resolveCtx = buildResolveContext(createCtx(), []);

    expect(resolveCtx.model).toEqual({ id: "openai/gpt-5.5" });
  });

  it("includes null before a model is selected", () => {
    const ctx = createCtx();
    ctx.set(StaticModelReferenceKey, null);

    expect(buildResolveContext(ctx, []).model).toBeNull();
  });

  it("includes channel metadata from ChannelInstrumentationKey", () => {
    const ctx = createCtx();
    ctx.set(ChannelKey, { kind: "http" });
    ctx.set(ChannelInstrumentationKey, {
      kind: "channel:slack",
      metadata: { threadTs: "1234.5678", userId: "U123" },
    });

    const resolveCtx = buildResolveContext(ctx, []);

    expect(resolveCtx.channel.continuationToken).toBe("token-1");
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

  it("omits continuation token for an ID-only session", () => {
    const ctx = new ContextContainer();
    ctx.set(StaticModelReferenceKey, { id: "openai/gpt-5.5" });
    ctx.set(SessionIdKey, "sess-1");
    ctx.set(AuthKey, null);
    ctx.set(InitiatorAuthKey, null);

    expect(buildResolveContext(ctx, []).channel.continuationToken).toBeUndefined();
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
