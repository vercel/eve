import { MockLanguageModelV3 } from "ai/test";
import { describe, expect, it } from "vitest";

import { ContextContainer } from "#context/container.js";
import {
  LiveStepDynamicModelSelectionKey,
  StaticModelReferenceKey,
  AuthKey,
  ChannelInstrumentationKey,
  ContinuationTokenKey,
  InitiatorAuthKey,
  SessionIdKey,
} from "#context/keys.js";
import { BundleKey, ChannelKey } from "#runtime/sessions/runtime-context-keys.js";
import { ROOT_COMPILED_AGENT_NODE_ID } from "#compiler/manifest.js";
import { readAgentModelSelection } from "#context/agent-model-selection.js";
import { buildResolveContext } from "#context/dynamic-resolve-context.js";

const mockLanguageModel = new MockLanguageModelV3({ provider: "custom", modelId: "model" });

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

  it("includes the active model context window when configured", () => {
    const ctx = createCtx();
    ctx.set(StaticModelReferenceKey, { id: "custom/model", contextWindowTokens: 1_000_000 });

    expect(buildResolveContext(ctx, []).model).toEqual({
      id: "custom/model",
      contextWindowTokens: 1_000_000,
    });
  });

  it("records the node that holds a source-backed model", () => {
    const source = { sourceKind: "module" as const, logicalPath: "agent.ts", sourceId: "agent" };
    const ctx = createCtx();
    ctx.set(StaticModelReferenceKey, { id: "codex/gpt-5.5", contextWindowTokens: 200_000, source });
    ctx.set(BundleKey, { nodeId: "subagents/parent" } as never);

    const model = buildResolveContext(ctx, []).model;
    expect(model).toEqual({ id: "codex/gpt-5.5", contextWindowTokens: 200_000 });
    expect(readAgentModelSelection(model)?.reference).toEqual({
      id: "codex/gpt-5.5",
      contextWindowTokens: 200_000,
      source,
      sourceNodeId: "subagents/parent",
    });

    // An inherited reference keeps the node it came from.
    ctx.set(StaticModelReferenceKey, {
      id: "codex/gpt-5.5",
      source,
      sourceNodeId: ROOT_COMPILED_AGENT_NODE_ID,
    });
    expect(readAgentModelSelection(buildResolveContext(ctx, []).model)?.reference).toMatchObject({
      sourceNodeId: ROOT_COMPILED_AGENT_NODE_ID,
    });
  });

  it("keeps a live step provider instance behind the selection", () => {
    const ctx = createCtx();
    ctx.set(LiveStepDynamicModelSelectionKey, {
      model: mockLanguageModel,
      reference: { id: "custom/model", contextWindowTokens: 1_000_000 },
    });

    const model = buildResolveContext(ctx, []).model;
    expect(model).toEqual({ id: "custom/model", contextWindowTokens: 1_000_000 });
    expect(readAgentModelSelection(model)?.model).toBe(mockLanguageModel);
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
