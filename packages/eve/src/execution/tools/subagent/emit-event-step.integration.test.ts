import { beforeEach, expect, it, vi } from "vitest";

import { ContextContainer, loadContext } from "#context/container.js";
import {
  AuthKey,
  DynamicSkillManifestKey,
  SandboxKey,
  SessionIdKey,
  SessionKey,
  SessionTitleKey,
} from "#context/keys.js";
import { deserializeContext, serializeContext } from "#context/serialize.js";
import { handleSubagentEvent } from "#execution/tools/subagent/handle-event.js";
import { emitSubagentEventStep } from "#execution/tools/subagent/emit-event-step.js";
import { createStubSandboxRegistry } from "#internal/testing/stub-sandbox-registry.js";
import { createTestSessionState } from "#internal/testing/session-state.js";
import type { MessageStreamEvent, UnstampedMessageStreamEvent } from "#protocol/message.js";
import type { HookContext, HookEvent, StreamEventHook } from "#public/definitions/hook.js";
import { createRuntimeHookRegistry } from "#runtime/hooks/registry.js";
import {
  BundleKey,
  ChannelKey,
  type CompiledBundle,
} from "#runtime/sessions/runtime-context-keys.js";

vi.mock("#context/serialize.js", () => ({
  deserializeContext: vi.fn(),
  serializeContext: vi.fn(),
}));

beforeEach(() => vi.resetAllMocks());

const events: UnstampedMessageStreamEvent[] = [
  {
    type: "subagent.called",
    data: {
      callId: "call",
      name: "research",
      toolName: "research",
      sessionId: "parent",
      childSessionId: "child",
      childStreamPath: "/child",
      workflowId: "workflow",
      turnId: "turn",
      sequence: 0,
    },
  },
  {
    type: "subagent.completed",
    data: { callId: "call", subagentName: "research", output: "done" },
  },
];

it.each(
  events.flatMap((event) =>
    (["typed", "wildcard", "both"] as const).flatMap((subscription) =>
      [false, true].map((fails) => ({ event, subscription, fails })),
    ),
  ),
)(
  "restores parent context for $event.type ($subscription, hook fails: $fails)",
  async ({ event, subscription, fails }) => {
    const calls: string[] = [];
    const ctx = new ContextContainer();
    ctx.set(SessionIdKey, "parent");
    ctx.set(AuthKey, null);
    ctx.set(DynamicSkillManifestKey, {
      policy: [{ name: "policy", description: "Parent delegation policy" }],
    });
    // SessionKey is virtual: a production deserializer cannot restore it.
    expect(ctx.has(SessionKey)).toBe(false);
    expect(ctx.has(SandboxKey)).toBe(false);
    ctx.set(ChannelKey, {
      kind: "test",
      state: {},
      [event.type](_data: unknown, adapterCtx: { state: unknown }) {
        calls.push("adapter");
        adapterCtx.state = { delivered: true };
      },
    });
    const handler = (kind: string) => async (received: HookEvent, hookCtx: HookContext) => {
      expect(hookCtx.session.id).toBe("parent");
      expect(hookCtx.session.auth).toEqual({ current: null, initiator: null });
      expect(received.type).toBe(event.type);
      if (received.type === "subagent.completed") expect(received.data.output).toBe("done");
      expect(loadContext()).toBe(ctx);
      expect(stream.locked).toBe(false);
      expect(received).toEqual(JSON.parse(new TextDecoder().decode(chunks[0])));
      expect(ctx.has(SandboxKey)).toBe(true);
      expect(hookCtx.getSkill("policy").name).toBe("policy");
      calls.push(kind);
      if (fails) throw new Error("subagent subscriber failed");
      ctx.set(SessionTitleKey, "Research event received");
    };
    const handlers: Record<string, StreamEventHook<MessageStreamEvent>> = {};
    if (subscription !== "wildcard") handlers[event.type] = handler("typed");
    if (subscription !== "typed") handlers["*"] = handler("wildcard");
    const hookRegistry = createRuntimeHookRegistry([
      {
        slug: "subagent-events",
        logicalPath: "hooks/subagent-events.ts",
        sourceId: "hooks/subagent-events.ts",
        sourceKind: "module",
        exportName: undefined,
        events: handlers,
      },
    ]);
    const bundle: Partial<CompiledBundle> = {
      graph: {
        root: { nodeId: "__root__", sandboxRegistry: createStubSandboxRegistry() },
      } as CompiledBundle["graph"],
      resolvedAgent: { config: {} } as CompiledBundle["resolvedAgent"],
      turnAgent: {
        id: "parent",
        model: { id: "openai/gpt-5.5" },
        tools: [],
        instructions: [],
        workspaceSpec: { rootEntries: [] },
      },
      compiledArtifactsSource: { kind: "bundled" },
      hookRegistry,
    };
    ctx.set(BundleKey, bundle as CompiledBundle);
    vi.mocked(deserializeContext).mockResolvedValue(ctx);
    vi.mocked(serializeContext).mockImplementation((context) =>
      Object.fromEntries([...context.entries()].map(([key, value]) => [key.name, value])),
    );
    const chunks: Uint8Array[] = [];
    const stream = new WritableStream<Uint8Array>({
      write(chunk) {
        calls.push("stream");
        chunks.push(chunk);
      },
    });
    const emitted = handleSubagentEvent({
      event,
      sessionWritable: stream,
      serializedContext: {},
      sessionState: createTestSessionState({ sessionId: "parent" }),
    });
    const firstHandler = subscription === "wildcard" ? "wildcard" : "typed";
    if (fails) {
      await expect(emitted).rejects.toThrow("subagent subscriber failed");
      expect(calls).toEqual(["adapter", "stream", firstHandler]);
    } else {
      const result = await emitted;
      expect(result.serializedContext[SessionTitleKey.name]).toBe("Research event received");
      expect(result.serializedContext[SessionKey.name]).toBeUndefined();
      expect(result.serializedContext[SandboxKey.name]).toBeUndefined();
      expect(result.sessionState.snapshot.session.sandboxState).toEqual({ session: null });
      expect(result.serializedContext[DynamicSkillManifestKey.name]).toEqual(
        ctx.require(DynamicSkillManifestKey),
      );
      expect(ctx.require(ChannelKey).state).toEqual({ delivered: true });
      expect(calls).toEqual([
        "adapter",
        "stream",
        firstHandler,
        ...(subscription === "both" ? ["wildcard"] : []),
      ]);
    }
    expect(chunks).toHaveLength(1);
    expect(new TextDecoder().decode(chunks[0])).toContain(`"type":"${event.type}"`);
    expect(stream.locked).toBe(false);
  },
);

it.each(events)("publishes $type without preparing hook or model context", async (event) => {
  const ctx = new ContextContainer();
  ctx.set(SessionIdKey, "parent");
  ctx.set(AuthKey, null);
  ctx.set(ChannelKey, { kind: "test" });
  const hook = vi.fn(() => {
    throw new Error("publication invoked a hook");
  });
  const bundle: Partial<CompiledBundle> = {
    get graph(): never {
      throw new Error("publication read model configuration");
    },
    hookRegistry: createRuntimeHookRegistry([
      {
        slug: "audit",
        logicalPath: "hooks/audit.ts",
        sourceId: "hooks/audit.ts",
        sourceKind: "module",
        exportName: undefined,
        events: { "*": hook },
      },
    ]),
  };
  ctx.set(BundleKey, bundle as CompiledBundle);
  vi.mocked(deserializeContext).mockResolvedValue(ctx);
  vi.mocked(serializeContext).mockReturnValue({});
  const chunks: Uint8Array[] = [];
  const stream = new WritableStream<Uint8Array>({
    write(chunk) {
      chunks.push(chunk);
    },
  });
  await emitSubagentEventStep({
    event,
    sessionWritable: stream,
    serializedContext: {},
    sessionState: createTestSessionState({ sessionId: "parent" }),
  });
  expect(hook).not.toHaveBeenCalled();
  expect(ctx.has(SessionKey)).toBe(false);
  expect(ctx.has(SandboxKey)).toBe(false);
  expect(chunks).toHaveLength(1);
  expect(stream.locked).toBe(false);
});
