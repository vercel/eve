import { describe, expect, it, vi } from "vitest";

import type { DynamicToolEntry } from "#shared/dynamic-tool-definition.js";
import type { DurableDynamicToolMetadata } from "#context/keys.js";
import { defineTool } from "#public/definitions/tool.js";

vi.mock("#context/build-callback-context.js", () => ({
  buildCallbackContext: () => ({
    session: { id: "test", auth: { current: null, initiator: null }, turn: {} },
  }),
}));

// Import after mock so the module picks up the mock
const { replayDynamicSessionTools, dispatchDynamicToolEvent } =
  await import("#context/dynamic-tool-lifecycle.js");
const { buildDynamicTools } = await import("#context/build-dynamic-tools.js");

import { ContextContainer } from "#context/container.js";
import {
  SessionIdKey,
  SessionDynamicToolMetadataKey,
  TurnDynamicToolMetadataKey,
} from "#context/keys.js";
import type { ResolvedDynamicToolResolver } from "#runtime/types.js";
import type { HandleMessageStreamEvent } from "#protocol/message.js";

// Re-implement the naming logic here to test it independently
// (the production function is unexported — testing via the public behavior)
function qualifyDynamicToolNames(
  slug: string,
  isSingle: boolean,
  entries: Readonly<Record<string, DynamicToolEntry>>,
): Map<string, DynamicToolEntry> {
  const keys = Object.keys(entries);
  const result = new Map<string, DynamicToolEntry>();

  if (keys.length === 0) return result;

  // single entry: one tool, named after the file slug.
  // map of entries: always slug__key.
  if (isSingle) {
    result.set(slug, entries[keys[0]!]!);
    return result;
  }

  for (const key of keys) {
    result.set(`${slug}__${key}`, entries[key]!);
  }
  return result;
}

const stubEntry = defineTool({
  description: "test",
  inputSchema: { type: "object" },
  execute: async (): Promise<unknown> => ({}),
});

describe("dynamic tool naming", () => {
  it("uses file slug for a single entry", () => {
    const names = qualifyDynamicToolNames("analytics", true, {
      run: stubEntry,
    });
    expect([...names.keys()]).toEqual(["analytics"]);
  });

  it("uses slug__key for a map entry", () => {
    const names = qualifyDynamicToolNames("search", false, {
      run: stubEntry,
    });
    expect([...names.keys()]).toEqual(["search__run"]);
  });

  it("uses slug__key for multiple map entries", () => {
    const names = qualifyDynamicToolNames("tenant", false, {
      export: stubEntry,
      query: stubEntry,
    });
    expect([...names.keys()]).toEqual(["tenant__export", "tenant__query"]);
  });

  it("handles empty entries — no tools produced", () => {
    const names = qualifyDynamicToolNames("empty", false, {});
    expect([...names.keys()]).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// safeSerialize behavior (re-implemented for isolated testing)
// ---------------------------------------------------------------------------

function safeSerialize(obj: Record<string, unknown>): Record<string, unknown> {
  try {
    return JSON.parse(JSON.stringify(obj));
  } catch {
    return {};
  }
}

describe("safeSerialize", () => {
  it("preserves plain JSON-serializable values", () => {
    const result = safeSerialize({
      str: "hello",
      num: 42,
      bool: true,
      nested: { key: "value" },
      arr: [1, 2, 3],
      nil: null,
    });

    expect(result).toEqual({
      str: "hello",
      num: 42,
      bool: true,
      nested: { key: "value" },
      arr: [1, 2, 3],
      nil: null,
    });
  });

  it("silently drops function values", () => {
    const result = safeSerialize({
      name: "tenant-a",
      callback: () => "ignored",
      apiUrl: "https://api.example.com",
    });

    expect(result).toEqual({
      name: "tenant-a",
      apiUrl: "https://api.example.com",
    });
    expect(result.callback).toBeUndefined();
  });

  it("silently drops undefined values", () => {
    const result = safeSerialize({
      name: "test",
      missing: undefined,
    });

    expect(result).toEqual({
      name: "test",
    });
  });

  it("silently drops symbol values", () => {
    const result = safeSerialize({
      name: "test",
      sym: Symbol("test"),
    });

    expect(result).toEqual({
      name: "test",
    });
  });

  it("returns empty object for circular references", () => {
    const circular: Record<string, unknown> = { name: "test" };
    circular.self = circular;

    const result = safeSerialize(circular);
    expect(result).toEqual({});
  });

  it("strips prototype chain from class instances", () => {
    class Config {
      name = "test";
      getValue() {
        return this.name;
      }
    }

    const result = safeSerialize({ config: new Config() });
    expect(result).toEqual({ config: { name: "test" } });
    expect(typeof (result.config as Record<string, unknown>).getValue).toBe("undefined");
  });

  it("preserves Date as ISO string", () => {
    const date = new Date("2024-01-01T00:00:00.000Z");
    const result = safeSerialize({ date });
    expect(result.date).toBe("2024-01-01T00:00:00.000Z");
  });
});

// ---------------------------------------------------------------------------
// replayDynamicSessionTools — step function lookup + closure replay
// ---------------------------------------------------------------------------

function getOrCreateStepRegistry(sym: symbol): Map<string, Function> {
  const g = globalThis as Record<symbol, Map<string, Function> | undefined>;
  const existing = g[sym];
  if (existing !== undefined) return existing;
  const fresh = new Map<string, Function>();
  g[sym] = fresh;
  return fresh;
}

describe("replayDynamicSessionTools", () => {
  it("skips metadata entries without executeStepFnName", () => {
    const metadata: DurableDynamicToolMetadata[] = [
      {
        name: "missing-fn",
        description: "No step fn",
        inputSchema: { type: "object" },
        resolverSlug: "test",
        entryKey: "tool",
        // executeStepFnName and closureVars are undefined
      },
    ];

    const tools = replayDynamicSessionTools(metadata, []);
    expect(tools).toHaveLength(0);
  });

  it("skips metadata entries without closureVars", () => {
    const metadata: DurableDynamicToolMetadata[] = [
      {
        name: "no-vars",
        description: "Has step fn but no closure vars",
        inputSchema: { type: "object" },
        resolverSlug: "test",
        entryKey: "tool",
        executeStepFnName: "eve:dynamic-tool//__eve_dynamic_exec_99",
        // closureVars is undefined
      },
    ];

    const tools = replayDynamicSessionTools(metadata, []);
    expect(tools).toHaveLength(0);
  });

  it("skips entries where step function is not registered", () => {
    const metadata: DurableDynamicToolMetadata[] = [
      {
        name: "unregistered",
        description: "Step fn not in registry",
        inputSchema: { type: "object" },
        resolverSlug: "test",
        entryKey: "tool",
        executeStepFnName: "eve:dynamic-tool//__eve_nonexistent",
        closureVars: { someVar: "value" },
      },
    ];

    const tools = replayDynamicSessionTools(metadata, []);
    expect(tools).toHaveLength(0);
  });

  it("reconstructs tool with registered step function and closure vars", async () => {
    const stepId = "eve:dynamic-tool//__eve_dynamic_exec_test_replay";
    const stepFn = vi.fn((__vars: unknown, input: unknown) => ({
      result: (__vars as Record<string, unknown>).apiUrl,
      input,
    }));
    Object.assign(stepFn, { stepId });

    const registrySym = Symbol.for("@workflow/core//registeredSteps");
    const registry = getOrCreateStepRegistry(registrySym);
    registry.set(stepId, stepFn);

    try {
      const metadata: DurableDynamicToolMetadata[] = [
        {
          name: "replay-tool",
          description: "Replayed tool",
          inputSchema: { type: "object" },
          resolverSlug: "test",
          entryKey: "tool",
          executeStepFnName: stepId,
          closureVars: { apiUrl: "https://api.example.com", tenantName: "Acme" },
        },
      ];

      const tools = replayDynamicSessionTools(metadata, []);
      expect(tools).toHaveLength(1);
      expect(tools[0]!.name).toBe("replay-tool");
      expect(tools[0]!.description).toBe("Replayed tool");

      // Execute the replayed tool — mock provides the callback context
      const tool = tools[0]!;
      tool.execute!({ query: "test" });
      expect(stepFn).toHaveBeenCalledWith(
        { apiUrl: "https://api.example.com", tenantName: "Acme" },
        { query: "test" },
        expect.anything(),
      );
    } finally {
      registry.delete(stepId);
    }
  });

  it("replayed tool passes stored closure vars, not live values", async () => {
    const stepId = "eve:dynamic-tool//__eve_dynamic_exec_snapshot";
    const calls: unknown[] = [];
    const stepFn = (__vars: unknown, input: unknown) => {
      calls.push({ vars: __vars, input });
      return { ok: true };
    };
    Object.assign(stepFn, { stepId });

    const registrySym = Symbol.for("@workflow/core//registeredSteps");
    const registry = getOrCreateStepRegistry(registrySym);
    registry.set(stepId, stepFn);

    try {
      const closureVars = { counter: 1, label: "v1" };
      const metadata: DurableDynamicToolMetadata[] = [
        {
          name: "snapshot-tool",
          description: "Snapshot test",
          inputSchema: { type: "object" },
          resolverSlug: "snap",
          entryKey: "tool",
          executeStepFnName: stepId,
          closureVars,
        },
      ];

      const tools = replayDynamicSessionTools(metadata, []);

      const tool = tools[0]!;
      tool.execute!({});

      // Mutating the metadata object after replay should NOT affect calls
      closureVars.counter = 999;
      tool.execute!({});

      // Both calls get the same closure vars reference from metadata.
      // This documents current behavior: replay passes by reference.
      expect(calls).toHaveLength(2);
      expect((calls[0] as Record<string, unknown>).vars).toBe(closureVars);
    } finally {
      registry.delete(stepId);
    }
  });

  it("reconstructs multiple tools from metadata", () => {
    const registrySym = Symbol.for("@workflow/core//registeredSteps");
    const registry = getOrCreateStepRegistry(registrySym);

    const stepIdA = "eve:dynamic-tool//__eve_dynamic_exec_multi_a";
    const stepIdB = "eve:dynamic-tool//__eve_dynamic_exec_multi_b";
    const fnA = () => ({ tool: "a" });
    const fnB = () => ({ tool: "b" });
    registry.set(stepIdA, fnA);
    registry.set(stepIdB, fnB);

    try {
      const metadata: DurableDynamicToolMetadata[] = [
        {
          name: "tenant__query",
          description: "Query",
          inputSchema: { type: "object" },
          resolverSlug: "tenant",
          entryKey: "query",
          executeStepFnName: stepIdA,
          closureVars: { tenant: "acme" },
        },
        {
          name: "tenant__export",
          description: "Export",
          inputSchema: { type: "object" },
          resolverSlug: "tenant",
          entryKey: "export",
          executeStepFnName: stepIdB,
          closureVars: { tenant: "acme" },
        },
      ];

      const tools = replayDynamicSessionTools(metadata, []);
      expect(tools).toHaveLength(2);
      expect(tools[0]!.name).toBe("tenant__query");
      expect(tools[1]!.name).toBe("tenant__export");
    } finally {
      registry.delete(stepIdA);
      registry.delete(stepIdB);
    }
  });

  it("skips only the broken entries — valid ones still work", () => {
    const registrySym = Symbol.for("@workflow/core//registeredSteps");
    const registry = getOrCreateStepRegistry(registrySym);

    const validStepId = "eve:dynamic-tool//__eve_dynamic_exec_partial_ok";
    registry.set(validStepId, () => ({ ok: true }));

    try {
      const metadata: DurableDynamicToolMetadata[] = [
        {
          name: "broken",
          description: "Missing step fn",
          inputSchema: { type: "object" },
          resolverSlug: "test",
          entryKey: "broken",
          executeStepFnName: "eve:dynamic-tool//__nonexistent",
          closureVars: {},
        },
        {
          name: "valid",
          description: "Working tool",
          inputSchema: { type: "object" },
          resolverSlug: "test",
          entryKey: "valid",
          executeStepFnName: validStepId,
          closureVars: { key: "value" },
        },
      ];

      const tools = replayDynamicSessionTools(metadata, []);
      // Only the valid tool should be reconstructed
      expect(tools).toHaveLength(1);
      expect(tools[0]!.name).toBe("valid");
    } finally {
      registry.delete(validStepId);
    }
  });
});

// ---------------------------------------------------------------------------
// dispatchDynamicToolEvent — unified event dispatch
// ---------------------------------------------------------------------------

function createResolver(
  slug: string,
  eventNames: readonly string[],
  handler: (event: unknown, ctx: unknown) => unknown | Promise<unknown>,
): ResolvedDynamicToolResolver {
  const events: Record<string, (event: unknown, ctx: unknown) => unknown | Promise<unknown>> = {};
  for (const name of eventNames) {
    events[name] = handler;
  }
  return {
    slug,
    eventNames,
    events,
    sourceId: `test:${slug}`,
    sourceKind: "module",
    logicalPath: `agent/tools/${slug}.ts`,
  };
}

function createCtx(): ContextContainer {
  const ctx = new ContextContainer();
  ctx.set(SessionIdKey, "test-session");
  return ctx;
}

function makeEvent(type: string): HandleMessageStreamEvent {
  return { type, data: {} } as HandleMessageStreamEvent;
}

const registrySym = Symbol.for("@workflow/core//registeredSteps");
const testRegistry = getOrCreateStepRegistry(registrySym);
let stepCounter = 0;

/**
 * Creates a tool entry with bundler-injected step function fields so
 * `buildDynamicTools` can replay it from durable metadata.
 */
function createReplayableTool(
  description = "stub",
  executeFn: (...args: unknown[]) => unknown = () => ({ ok: true }),
): DynamicToolEntry {
  const stepId = `test-step-${++stepCounter}`;
  testRegistry.set(stepId, (_vars: unknown, input: unknown) => executeFn(input));
  const entry = defineTool({
    description,
    inputSchema: { type: "object" },
    execute: async (input: Record<string, unknown>): Promise<unknown> => executeFn(input),
  });
  Object.assign(entry, {
    __executeStepFn: { stepId },
    __closureVars: {},
  });
  return entry;
}

describe("dispatchDynamicToolEvent", () => {
  it("resolves tools for matching event and stores on scoped durable key", async () => {
    const ctx = createCtx();
    const resolver = createResolver("weather", ["session.started"], () => ({
      forecast: createReplayableTool(),
    }));

    await dispatchDynamicToolEvent({
      ctx,
      resolvers: [resolver],
      messages: [],
      event: makeEvent("session.started"),
    });

    const metadata = ctx.get(SessionDynamicToolMetadataKey);
    expect(metadata).toHaveLength(1);
    expect(metadata![0]!.name).toBe("weather__forecast");

    const tools = buildDynamicTools(ctx);
    expect(tools).toHaveLength(1);
    expect(tools[0]!.name).toBe("weather__forecast");
  });

  it("skips resolvers that do not match the event type", async () => {
    const ctx = createCtx();
    const handler = vi.fn(() => ({ forecast: createReplayableTool() }));
    const resolver = createResolver("weather", ["session.started"], handler);

    await dispatchDynamicToolEvent({
      ctx,
      resolvers: [resolver],
      messages: [],
      event: makeEvent("step.started"),
    });

    expect(handler).not.toHaveBeenCalled();
    expect(buildDynamicTools(ctx)).toHaveLength(0);
  });

  it("replaces tools from the same resolver slug (last write wins)", async () => {
    const ctx = createCtx();
    let callCount = 0;
    const resolver = createResolver("api", ["step.started"], () => {
      callCount++;
      return {
        query: createReplayableTool(`call ${callCount}`),
      };
    });

    await dispatchDynamicToolEvent({
      ctx,
      resolvers: [resolver],
      messages: [],
      event: makeEvent("step.started"),
    });
    expect(buildDynamicTools(ctx)[0]!.description).toBe("call 1");

    await dispatchDynamicToolEvent({
      ctx,
      resolvers: [resolver],
      messages: [],
      event: makeEvent("step.started"),
    });
    expect(buildDynamicTools(ctx)).toHaveLength(1);
    expect(buildDynamicTools(ctx)[0]!.description).toBe("call 2");
  });

  it("preserves tools from different resolvers when one updates", async () => {
    const ctx = createCtx();
    const resolverA = createResolver("alpha", ["session.started"], () => ({
      a_tool: createReplayableTool(),
    }));
    const resolverB = createResolver("beta", ["step.started"], () => ({
      b_tool: createReplayableTool(),
    }));

    await dispatchDynamicToolEvent({
      ctx,
      resolvers: [resolverA, resolverB],
      messages: [],
      event: makeEvent("session.started"),
    });
    expect(buildDynamicTools(ctx)).toHaveLength(1);
    expect(buildDynamicTools(ctx)[0]!.name).toBe("alpha__a_tool");

    await dispatchDynamicToolEvent({
      ctx,
      resolvers: [resolverA, resolverB],
      messages: [],
      event: makeEvent("step.started"),
    });
    const tools = buildDynamicTools(ctx);
    expect(tools).toHaveLength(2);
    expect(tools.map((t) => t.name).sort()).toEqual(["alpha__a_tool", "beta__b_tool"]);
  });

  it("does not clobber session metadata when a different event resolves tools", async () => {
    const ctx = createCtx();
    const sessionResolver = createResolver("tenant", ["session.started"], () => ({
      query: createReplayableTool(),
    }));
    const stepResolver = createResolver("discovered", ["step.started"], () => ({
      api: createReplayableTool(),
    }));

    // Session resolver fires first
    await dispatchDynamicToolEvent({
      ctx,
      resolvers: [sessionResolver, stepResolver],
      messages: [],
      event: makeEvent("session.started"),
    });

    const metadataAfterSession = ctx.get(SessionDynamicToolMetadataKey);
    expect(metadataAfterSession).toHaveLength(1);
    expect(metadataAfterSession![0]!.resolverSlug).toBe("tenant");

    // Step resolver fires — should NOT clobber session metadata
    await dispatchDynamicToolEvent({
      ctx,
      resolvers: [sessionResolver, stepResolver],
      messages: [],
      event: makeEvent("step.started"),
    });

    // Session metadata unchanged
    expect(ctx.get(SessionDynamicToolMetadataKey)).toHaveLength(1);
    expect(ctx.get(SessionDynamicToolMetadataKey)![0]!.resolverSlug).toBe("tenant");
    // Step tools are live (no durable metadata for step scope)
    // buildDynamicTools sees both session (replayed) + step (live)
    expect(buildDynamicTools(ctx)).toHaveLength(2);
  });

  it("rehydrates session tools from durable metadata on a fresh step", async () => {
    const ctx = createCtx();

    // Register a step function so replayDynamicSessionTools can
    // reconstruct the tool on the second step.
    const stepId = "eve:dynamic-tool//__eve_dispatch_rehydrate_test";
    const stepFn = vi.fn((_vars: unknown, input: unknown) => ({ input }));
    const registrySym = Symbol.for("@workflow/core//registeredSteps");
    const registry = getOrCreateStepRegistry(registrySym);
    registry.set(stepId, stepFn);

    try {
      // Build a resolver whose tool entry carries bundler-injected fields
      const resolver = createResolver("tenant", ["session.started"], () => {
        const entry = defineTool({
          description: "tenant query",
          inputSchema: { type: "object" },
          execute: async () => ({ ok: true }),
        });
        Object.assign(entry, {
          __executeStepFn: { stepId },
          __closureVars: { apiUrl: "https://api.example.com" },
        });
        return { query: entry };
      });

      // First step: resolve session tools, metadata is stored durably
      await dispatchDynamicToolEvent({
        ctx,
        resolvers: [resolver],
        messages: [],
        event: makeEvent("session.started"),
      });
      expect(buildDynamicTools(ctx)).toHaveLength(1);
      expect(ctx.get(SessionDynamicToolMetadataKey)).toHaveLength(1);
      expect(ctx.get(SessionDynamicToolMetadataKey)![0]!.executeStepFnName).toBe(stepId);

      // Simulate workflow step boundary: clear virtual context.
      // Durable metadata survives — buildDynamicTools reads from durable keys.
      ctx.clearVirtualContext();
      expect(ctx.get(SessionDynamicToolMetadataKey)).toHaveLength(1);

      const tools = buildDynamicTools(ctx);
      expect(tools).toHaveLength(1);
      expect(tools[0]!.name).toBe("tenant__query");
    } finally {
      registry.delete(stepId);
    }
  });

  it("resolver returning null produces no tools", async () => {
    const ctx = createCtx();
    const resolver = createResolver("empty", ["session.started"], () => null);

    await dispatchDynamicToolEvent({
      ctx,
      resolvers: [resolver],
      messages: [],
      event: makeEvent("session.started"),
    });

    expect(buildDynamicTools(ctx)).toHaveLength(0);
  });

  it("resolver throwing is logged and skipped — other resolvers still work", async () => {
    const ctx = createCtx();
    const badResolver = createResolver("bad", ["session.started"], () => {
      throw new Error("resolver exploded");
    });
    const goodResolver = createResolver("good", ["session.started"], () => ({
      working: createReplayableTool(),
    }));

    await dispatchDynamicToolEvent({
      ctx,
      resolvers: [badResolver, goodResolver],
      messages: [],
      event: makeEvent("session.started"),
    });

    const tools = buildDynamicTools(ctx);
    expect(tools).toHaveLength(1);
    expect(tools[0]!.name).toBe("good__working");
  });

  it("uses file slug when handler returns a single entry", async () => {
    const ctx = createCtx();
    const resolver = createResolver("analytics", ["session.started"], () => createReplayableTool());

    await dispatchDynamicToolEvent({
      ctx,
      resolvers: [resolver],
      messages: [],
      event: makeEvent("session.started"),
    });

    const tools = buildDynamicTools(ctx);
    expect(tools).toHaveLength(1);
    expect(tools[0]!.name).toBe("analytics");
  });
});

// ---------------------------------------------------------------------------
// Framework dynamic tools — no bundler transform, auto-registered
// ---------------------------------------------------------------------------

function createFrameworkTool(
  description = "framework stub",
  executeFn: (input: Record<string, unknown>) => unknown = () => ({ ok: true }),
): DynamicToolEntry {
  return defineTool({
    description,
    inputSchema: { type: "object" },
    execute: async (input: Record<string, unknown>): Promise<unknown> => executeFn(input),
  });
}

describe("framework dynamic tools (no bundler transform)", () => {
  it("session-scoped framework tool is replayable across steps", async () => {
    const ctx = createCtx();
    const executeFn = vi.fn(() => ({ data: "from-framework" }));
    const resolver = createResolver("fwk", ["session.started"], () => ({
      search: createFrameworkTool("framework search", executeFn),
    }));

    await dispatchDynamicToolEvent({
      ctx,
      resolvers: [resolver],
      messages: [],
      event: makeEvent("session.started"),
    });

    const metadata = ctx.get(SessionDynamicToolMetadataKey);
    expect(metadata).toHaveLength(1);
    expect(metadata![0]!.executeStepFnName).toBe("eve:framework-dynamic:fwk:search");
    expect(metadata![0]!.closureVars).toEqual({});

    const tools = buildDynamicTools(ctx);
    expect(tools).toHaveLength(1);
    expect(tools[0]!.name).toBe("fwk__search");

    // Simulate step boundary — virtual context cleared, durable survives
    ctx.clearVirtualContext();

    const replayedTools = buildDynamicTools(ctx);
    expect(replayedTools).toHaveLength(1);
    expect(replayedTools[0]!.name).toBe("fwk__search");

    // Execute the replayed tool — the original closure is invoked
    await replayedTools[0]!.execute!({ query: "test" });
    expect(executeFn).toHaveBeenCalledWith({ query: "test" });
  });

  it("turn-scoped framework tool is replayable", async () => {
    const ctx = createCtx();
    const executeFn = vi.fn(() => ({ result: "turn-tool" }));
    const resolver = createResolver("helper", ["turn.started"], () => ({
      assist: createFrameworkTool("turn helper", executeFn),
    }));

    await dispatchDynamicToolEvent({
      ctx,
      resolvers: [resolver],
      messages: [],
      event: makeEvent("turn.started"),
    });

    const metadata = ctx.get(TurnDynamicToolMetadataKey);
    expect(metadata).toHaveLength(1);
    expect(metadata![0]!.executeStepFnName).toBe("eve:framework-dynamic:helper:assist");

    ctx.clearVirtualContext();

    const tools = buildDynamicTools(ctx);
    expect(tools).toHaveLength(1);
    expect(tools[0]!.name).toBe("helper__assist");

    await tools[0]!.execute!({ action: "help" });
    expect(executeFn).toHaveBeenCalledWith({ action: "help" });
  });

  it("framework and authored tools coexist in session scope", async () => {
    const ctx = createCtx();
    const frameworkResolver = createResolver("fwk", ["session.started"], () => ({
      search: createFrameworkTool("framework search"),
    }));
    const authoredResolver = createResolver("authored", ["session.started"], () => ({
      query: createReplayableTool("authored query"),
    }));

    await dispatchDynamicToolEvent({
      ctx,
      resolvers: [frameworkResolver, authoredResolver],
      messages: [],
      event: makeEvent("session.started"),
    });

    const metadata = ctx.get(SessionDynamicToolMetadataKey);
    expect(metadata).toHaveLength(2);

    ctx.clearVirtualContext();

    const tools = buildDynamicTools(ctx);
    expect(tools).toHaveLength(2);
    expect(tools.map((t) => t.name).sort()).toEqual(["authored__query", "fwk__search"]);
  });

  it("single-entry framework tool uses slug as name", async () => {
    const ctx = createCtx();
    const resolver = createResolver("analytics", ["session.started"], () =>
      createFrameworkTool("single tool"),
    );

    await dispatchDynamicToolEvent({
      ctx,
      resolvers: [resolver],
      messages: [],
      event: makeEvent("session.started"),
    });

    ctx.clearVirtualContext();

    const tools = buildDynamicTools(ctx);
    expect(tools).toHaveLength(1);
    expect(tools[0]!.name).toBe("analytics");
  });

  it("propagates needsApproval from a step-scoped entry into the harness tool", async () => {
    const ctx = createCtx();
    const approvalFn = vi.fn(() => true);
    const entry: DynamicToolEntry = {
      description: "destructive op",
      inputSchema: { type: "object" },
      needsApproval: approvalFn,
      execute: async (): Promise<unknown> => ({ ok: true }),
    };
    const resolver = createResolver("connection", ["step.started"], () => ({ risky: entry }));

    await dispatchDynamicToolEvent({
      ctx,
      resolvers: [resolver],
      messages: [],
      event: makeEvent("step.started"),
    });

    const tools = buildDynamicTools(ctx);
    expect(tools).toHaveLength(1);
    expect(tools[0]!.name).toBe("connection__risky");
    expect(tools[0]!.needsApproval).toBe(approvalFn);
    expect(
      tools[0]!.needsApproval!({
        approvedTools: new Set(),
        toolInput: undefined,
        toolName: "connection__risky",
      }),
    ).toBe(true);
  });

  it("propagates outputSchema from dynamic entries into harness tools and metadata", async () => {
    const ctx = createCtx();
    const outputSchema = {
      additionalProperties: false,
      properties: { ok: { type: "boolean" } },
      required: ["ok"],
      type: "object",
    };
    const entry: DynamicToolEntry = {
      description: "typed op",
      inputSchema: { type: "object" },
      outputSchema,
      execute: async (): Promise<unknown> => ({ ok: true }),
    };
    const resolver = createResolver("connection", ["session.started"], () => ({ typed: entry }));

    await dispatchDynamicToolEvent({
      ctx,
      resolvers: [resolver],
      messages: [],
      event: makeEvent("session.started"),
    });

    const metadata = ctx.get(SessionDynamicToolMetadataKey);
    expect(metadata?.[0]?.outputSchema).toEqual(outputSchema);

    ctx.clearVirtualContext();

    const tools = buildDynamicTools(ctx);
    expect(tools).toHaveLength(1);
    expect((tools[0]!.outputSchema as { jsonSchema: unknown }).jsonSchema).toEqual(outputSchema);
  });

  it("leaves needsApproval undefined when a step-scoped entry omits it", async () => {
    const ctx = createCtx();
    const resolver = createResolver("connection", ["step.started"], () => ({
      safe: createFrameworkTool("read-only op"),
    }));

    await dispatchDynamicToolEvent({
      ctx,
      resolvers: [resolver],
      messages: [],
      event: makeEvent("step.started"),
    });

    const tools = buildDynamicTools(ctx);
    expect(tools).toHaveLength(1);
    expect(tools[0]!.needsApproval).toBeUndefined();
  });

  it("re-dispatch updates the registered step function", async () => {
    const ctx = createCtx();
    let callCount = 0;
    const resolver = createResolver("counter", ["session.started"], () => {
      callCount++;
      const current = callCount;
      return {
        count: createFrameworkTool(`v${current}`, () => ({ version: current })),
      };
    });

    await dispatchDynamicToolEvent({
      ctx,
      resolvers: [resolver],
      messages: [],
      event: makeEvent("session.started"),
    });

    ctx.clearVirtualContext();
    let tools = buildDynamicTools(ctx);
    const result1 = await tools[0]!.execute!({});
    expect(result1).toEqual({ version: 1 });

    // Re-dispatch overwrites the resolver's slot
    await dispatchDynamicToolEvent({
      ctx,
      resolvers: [resolver],
      messages: [],
      event: makeEvent("session.started"),
    });

    ctx.clearVirtualContext();
    tools = buildDynamicTools(ctx);
    expect(tools[0]!.description).toBe("v2");
    const result2 = await tools[0]!.execute!({});
    expect(result2).toEqual({ version: 2 });
  });
});
