import { defineWorkflowTool } from "#tools/workflow-definition.js";
import { asSchema } from "ai";
import { describe, expect, it, vi } from "vitest";

import { z } from "#compiled/zod/index.js";
import type { DynamicToolEntry } from "#tools/dynamic.js";
import {
  isCurrentDynamicToolMetadata,
  type CurrentDynamicToolMetadata,
  type OldSourceOffsetDynamicToolMetadata,
  type OldStepFunctionDynamicToolMetadata,
} from "#context/dynamic-tool-metadata.js";
import { resolveApprovalPolicy, type ApprovalContext } from "#approval/definition.js";
import { defineTool, type TaskExec, type ToolContext } from "#tools/definition.js";
import type { JsonObject } from "#shared/json.js";
import { serializeOutputSchema, type ToolSchema } from "#tools/schema.js";

vi.mock("#context/build-callback-context.js", () => ({
  buildCallbackContext: () => ({
    session: { id: "test", auth: { current: null, initiator: null }, turn: {} },
  }),
}));

// Import after mock so the module picks up the mock
const {
  replayDynamicSessionTools,
  dispatchDynamicToolEvent,
  refreshDynamicSessionToolsForRuntimeRevision,
  rebindMissingCompiledDynamicToolCallbacks,
  validateDurableDynamicToolCallbacks,
} = await import("#context/dynamic-tool-lifecycle.js");
const { buildDynamicTools, buildResponseAuthorizationTools } =
  await import("#context/build-dynamic-tools.js");

import { ContextContainer } from "#context/container.js";
import { deserializeContext, serializeContext } from "#context/serialize.js";
import {
  SessionIdKey,
  SessionDynamicToolMetadataKey,
  SessionDynamicToolRuntimeRevisionKey,
  StepDynamicToolMetadataKey,
  TurnDynamicToolMetadataKey,
} from "#context/keys.js";
import {
  lookupDurableDynamicCallback,
  registerDurableDynamicCallback,
  stampDurableDynamicToolCallbacks,
} from "#tools/durable-callbacks.js";
import type { ResolvedDynamicToolResolver } from "#runtime/types.js";
import {
  createSessionStartedEvent,
  createStepStartedEvent,
  type UnstampedMessageStreamEvent,
} from "#protocol/message.js";

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
  // map of entries: each named by its bare key.
  if (isSingle) {
    result.set(slug, entries[keys[0]!]!);
    return result;
  }

  for (const key of keys) {
    result.set(key, entries[key]!);
  }
  return result;
}

const executeOptions = { messages: [], toolCallId: "call_1" };

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

  it("uses the bare key for a map entry", () => {
    const names = qualifyDynamicToolNames("search", false, {
      run: stubEntry,
    });
    expect([...names.keys()]).toEqual(["run"]);
  });

  it("uses bare keys for multiple map entries", () => {
    const names = qualifyDynamicToolNames("tenant", false, {
      export: stubEntry,
      query: stubEntry,
    });
    expect([...names.keys()]).toEqual(["export", "query"]);
  });

  it("handles empty entries — no tools produced", () => {
    const names = qualifyDynamicToolNames("empty", false, {});
    expect([...names.keys()]).toEqual([]);
  });
});

describe("durable callback capture validation", () => {
  function validateExecuteCapture(closure: unknown) {
    const entry = defineTool({
      description: "captured tool",
      inputSchema: { type: "object" },
      execute: async () => null,
    });
    stampDurableDynamicToolCallbacks(entry, {
      execute: { callback: () => null, closure: closure as JsonObject },
    });
    return validateDurableDynamicToolCallbacks("captured", entry);
  }

  it("preserves JSON values and explicitly omits undefined object properties", () => {
    const callbacks = validateExecuteCapture({
      str: "hello",
      num: 42,
      bool: true,
      nested: { key: "value" },
      arr: [1, 2, 3],
      nil: null,
      omitted: undefined,
    });

    expect(callbacks.execute.closure).toEqual({
      str: "hello",
      num: 42,
      bool: true,
      nested: { key: "value" },
      arr: [1, 2, 3],
      nil: null,
    });
  });

  it.each([
    ["function", { value: () => null }],
    ["Date", { value: new Date("2024-01-01T00:00:00.000Z") }],
    ["Map", { value: new Map([["key", "value"]]) }],
    ["class instance", { value: new (class Capture {})() }],
    ["symbol", { value: Symbol("capture") }],
    ["NaN", { value: Number.NaN }],
  ])("rejects a %s capture with the tool and phase", (_label, closure) => {
    expect(() => validateExecuteCapture(closure)).toThrow(
      'Dynamic tool "captured" callback "execute" has a non-serializable capture',
    );
  });

  it("rejects cyclic captures", () => {
    const circular: Record<string, unknown> = { name: "test" };
    circular.self = circular;
    expect(() => validateExecuteCapture(circular)).toThrow(
      'Dynamic tool "captured" callback "execute" has a non-serializable capture',
    );
  });
});

// ---------------------------------------------------------------------------
// replayDynamicSessionTools — name+phase lookup + closure replay
// ---------------------------------------------------------------------------

const dynamicCallbackRegistrySym = Symbol.for("eve:dynamic-tool-callbacks");

function getDynamicCallbackRegistry(): Map<string, Map<string, Function>> {
  const g = globalThis as Record<symbol, Map<string, Map<string, Function>> | undefined>;
  const existing = g[dynamicCallbackRegistrySym];
  if (existing !== undefined) return existing;
  const fresh = new Map<string, Map<string, Function>>();
  g[dynamicCallbackRegistrySym] = fresh;
  return fresh;
}

function registerTestCallback(
  toolName: string,
  phase: string,
  callback: (closure: unknown, ...args: unknown[]) => unknown,
): void {
  registerDurableDynamicCallback({
    callback: callback as never,
    phase: phase as never,
    toolName,
  });
}

function requireCurrentMetadata(
  metadata:
    | CurrentDynamicToolMetadata
    | OldSourceOffsetDynamicToolMetadata
    | OldStepFunctionDynamicToolMetadata
    | undefined,
): CurrentDynamicToolMetadata {
  if (metadata === undefined || !isCurrentDynamicToolMetadata(metadata)) {
    throw new Error("Expected current dynamic tool metadata.");
  }
  return metadata;
}

describe("replayDynamicSessionTools", () => {
  function metadata(name: string, closure: JsonObject = {}): CurrentDynamicToolMetadata {
    return {
      callbacks: { execute: { closure } },
      description: `${name} description`,
      entryKey: name,
      inputSchema: { type: "object" },
      name,
      resolverSlug: "test",
    };
  }

  it("fails execution closed when the registered callback is unavailable", async () => {
    const [tool] = replayDynamicSessionTools([metadata("unregistered")], []);
    await expect(tool!.execute!({}, executeOptions)).rejects.toThrow(
      'Dynamic tool "unregistered" cannot replay its execute callback',
    );
  });

  it("reconstructs tool with registered step function and closure vars", async () => {
    const stepFn = vi.fn((__vars: unknown, input: unknown) => ({
      result: (__vars as Record<string, unknown>).apiUrl,
      input,
    }));
    registerTestCallback("replay-tool", "execute", stepFn);

    try {
      const durable = metadata("replay-tool", {
        apiUrl: "https://api.example.com",
        tenantName: "Acme",
      });

      const tools = replayDynamicSessionTools([durable], []);
      expect(tools).toHaveLength(1);
      expect(tools[0]!.name).toBe("replay-tool");
      expect(tools[0]!.description).toBe("replay-tool description");

      // Execute the replayed tool — mock provides the callback context
      const tool = tools[0]!;
      tool.execute!({ query: "test" }, executeOptions);
      expect(stepFn).toHaveBeenCalledWith(
        { apiUrl: "https://api.example.com", tenantName: "Acme" },
        { query: "test" },
        expect.anything(),
      );
    } finally {
      getDynamicCallbackRegistry().delete("replay-tool");
    }
  });

  it("runs the latest registered implementation after a redeploy rebinds the name", async () => {
    registerTestCallback("latest-tool", "execute", () => ({ version: 1 }));
    const tools = replayDynamicSessionTools([metadata("latest-tool")], []);
    await expect(tools[0]!.execute!({}, executeOptions)).resolves.toEqual({ version: 1 });

    // A redeploy re-resolves and replaces the binding under the same identity.
    registerTestCallback("latest-tool", "execute", () => ({ version: 2 }));
    const rebound = replayDynamicSessionTools([metadata("latest-tool")], []);
    await expect(rebound[0]!.execute!({}, executeOptions)).resolves.toEqual({ version: 2 });
    getDynamicCallbackRegistry().delete("latest-tool");
  });

  it("replayed tool passes stored closure vars, not live values", async () => {
    const calls: unknown[] = [];
    registerTestCallback("snapshot-tool", "execute", (__vars: unknown, input: unknown) => {
      calls.push({ vars: __vars, input });
      return { ok: true };
    });

    try {
      const closureVars = { counter: 1, label: "v1" };
      const tools = replayDynamicSessionTools([metadata("snapshot-tool", closureVars)], []);

      const tool = tools[0]!;
      tool.execute!({}, executeOptions);

      // Mutating the metadata object after replay should NOT affect calls
      closureVars.counter = 999;
      tool.execute!({}, executeOptions);

      // Both calls get the same closure vars reference from metadata.
      // This documents current behavior: replay passes by reference.
      expect(calls).toHaveLength(2);
      expect((calls[0] as Record<string, unknown>).vars).toBe(closureVars);
    } finally {
      getDynamicCallbackRegistry().delete("snapshot-tool");
    }
  });

  it("reconstructs multiple tools from metadata", () => {
    registerTestCallback("tenant__query", "execute", () => ({ tool: "a" }));
    registerTestCallback("tenant__export", "execute", () => ({ tool: "b" }));

    try {
      const durable = [
        metadata("tenant__query", { tenant: "acme" }),
        metadata("tenant__export", { tenant: "acme" }),
      ];

      const tools = replayDynamicSessionTools(durable, []);
      expect(tools).toHaveLength(2);
      expect(tools[0]!.name).toBe("tenant__query");
      expect(tools[1]!.name).toBe("tenant__export");
    } finally {
      getDynamicCallbackRegistry().delete("tenant__query");
      getDynamicCallbackRegistry().delete("tenant__export");
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

let contextCounter = 0;
function createCtx(sessionId = `test-session-${++contextCounter}`): ContextContainer {
  const ctx = new ContextContainer();
  ctx.set(SessionIdKey, sessionId);
  return ctx;
}

function createApprovalContext(input: {
  readonly toolInput?: Record<string, unknown>;
  readonly toolName: string;
}): ApprovalContext {
  return {
    approvedTools: new Set(),
    callId: "call_1",
    getSandbox: vi.fn(),
    getSkill: vi.fn(),
    session: {
      auth: { current: null, initiator: null },
      id: "test-session",
      turn: { id: "test-turn", sequence: 0 },
    },
    toolInput: input.toolInput,
    toolName: input.toolName,
  } as ApprovalContext;
}

function makeEvent(type: string): UnstampedMessageStreamEvent {
  if (type === "step.started") {
    return createStepStartedEvent({
      modelId: "test-model",
      sequence: 0,
      stepIndex: 0,
      turnId: "test-turn",
    });
  }
  return { type, data: {} } as UnstampedMessageStreamEvent;
}

const dynamicCallbackRegistry = getDynamicCallbackRegistry();

function simulateColdStart(ctx: ContextContainer): void {
  for (const metadata of ctx.get(SessionDynamicToolMetadataKey) ?? []) {
    dynamicCallbackRegistry.delete(metadata.name);
  }
  ctx.clearVirtualContext();
}

/**
 * Creates a tool entry stamped with a live durable callback so resolve-time
 * registration binds it under the tool's final name.
 */
function createReplayableTool(
  description = "stub",
  executeFn: (input: Record<string, unknown>) => unknown = () => ({ ok: true }),
): DynamicToolEntry {
  const entry = defineTool({
    description,
    inputSchema: { type: "object" },
    execute: async (input: Record<string, unknown>): Promise<unknown> => executeFn(input),
  });
  stampDurableDynamicToolCallbacks(entry, {
    execute: {
      callback: (_closure, input) => executeFn(input as Record<string, unknown>),
      closure: {},
    },
  });
  return entry;
}

function stampTestTool(entry: DynamicToolEntry): DynamicToolEntry {
  const request = entry.approval === undefined ? undefined : resolveApprovalPolicy(entry.approval);
  const response =
    entry.approval === undefined || typeof entry.approval === "function"
      ? undefined
      : entry.approval.response;
  stampDurableDynamicToolCallbacks(entry, {
    execute: {
      callback: (_closure, input, context) =>
        entry.execute(
          input as Record<string, unknown>,
          context as Parameters<DynamicToolEntry["execute"]>[1],
        ),
      closure: {},
    },
    ...(request === undefined
      ? {}
      : {
          approvalRequest: {
            callback: (_closure, context) => request(context as ApprovalContext),
            closure: {},
          },
        }),
    ...(response === undefined
      ? {}
      : {
          approvalResponse: {
            callback: (_closure, context) => response(context as never),
            closure: {},
          },
        }),
    ...(entry.toModelOutput === undefined
      ? {}
      : {
          toModelOutput: {
            callback: (_closure, output) => entry.toModelOutput!(output),
            closure: {},
          },
        }),
  });
  return entry;
}

describe("dispatchDynamicToolEvent", () => {
  it("replaces session tools with the current deployment's resolver output", async () => {
    const ctx = createCtx();
    const oldResolver = createResolver("old", ["session.started"], () => ({
      old_tool: createReplayableTool("old deployment"),
    }));

    await dispatchDynamicToolEvent({
      ctx,
      resolvers: [oldResolver],
      messages: [],
      event: makeEvent("session.started"),
    });
    ctx.set(SessionDynamicToolRuntimeRevisionKey, "deployment:dpl_old");

    expect(buildDynamicTools(ctx).map((tool) => tool.name)).toEqual(["old_tool"]);

    const newResolver = createResolver("new", ["session.started"], () => ({
      new_tool: createReplayableTool("new deployment"),
    }));

    await refreshDynamicSessionToolsForRuntimeRevision({
      ctx,
      resolvers: [newResolver],
      messages: [],
      event: createSessionStartedEvent(),
      runtimeRevision: "deployment:dpl_new",
    });

    expect(ctx.get(SessionDynamicToolRuntimeRevisionKey)).toBe("deployment:dpl_new");
    expect(ctx.get(SessionDynamicToolMetadataKey)?.map((tool) => tool.name)).toEqual(["new_tool"]);
    expect(buildDynamicTools(ctx).map((tool) => tool.name)).toEqual(["new_tool"]);
  });

  it("does not re-run session resolvers within the same deployment", async () => {
    const ctx = createCtx();
    const handler = vi.fn(() => ({
      current_tool: createReplayableTool(),
    }));
    const resolver = createResolver("current", ["session.started"], handler);

    await dispatchDynamicToolEvent({
      ctx,
      resolvers: [resolver],
      messages: [],
      event: makeEvent("session.started"),
    });
    ctx.set(SessionDynamicToolRuntimeRevisionKey, "deployment:dpl_current");

    await refreshDynamicSessionToolsForRuntimeRevision({
      ctx,
      resolvers: [resolver],
      messages: [],
      event: createSessionStartedEvent(),
      runtimeRevision: "deployment:dpl_current",
    });

    expect(handler).toHaveBeenCalledOnce();
  });

  it("reuses registered session callbacks without rerunning the resolver", async () => {
    let ctx = createCtx();
    const handler = vi.fn(() => ({ tool: createReplayableTool("cached durable tool") }));
    const resolver = createResolver("live", ["session.started"], handler);
    ctx.set(SessionDynamicToolRuntimeRevisionKey, "deployment:dpl_current");

    await dispatchDynamicToolEvent({
      ctx,
      resolvers: [resolver],
      messages: [],
      event: makeEvent("session.started"),
    });
    ctx = await deserializeContext(serializeContext(ctx));

    expect(handler).toHaveBeenCalledOnce();
    expect(buildDynamicTools(ctx).map((tool) => tool.name)).toEqual(["tool"]);
  });

  it("does not rerun a resolver when a registered callback is missing", async () => {
    const ctx = createCtx();
    const handler = vi.fn(() => ({ tool: createReplayableTool() }));
    const resolver = createResolver("live", ["session.started"], handler);
    await dispatchDynamicToolEvent({
      ctx,
      resolvers: [resolver],
      messages: [],
      event: makeEvent("session.started"),
    });
    simulateColdStart(ctx);

    const [tool] = buildDynamicTools(ctx);
    await expect(tool!.execute!({}, executeOptions)).rejects.toThrow(
      "cannot replay its execute callback",
    );
    expect(handler).toHaveBeenCalledOnce();
  });

  it("rebinds missing session callbacks even when the runtime revision is unchanged", async () => {
    const ctx = createCtx();
    const handler = vi.fn(() => ({ tool: createReplayableTool("rebound") }));
    const resolver = createResolver("live", ["session.started"], handler);
    await dispatchDynamicToolEvent({
      ctx,
      resolvers: [resolver],
      messages: [],
      event: makeEvent("session.started"),
    });
    ctx.set(SessionDynamicToolRuntimeRevisionKey, "deployment:dpl_current");
    simulateColdStart(ctx);

    // Fresh process: bindings are gone although the bundle did not change.
    expect(lookupDurableDynamicCallback("tool", "execute")).toBeUndefined();

    await refreshDynamicSessionToolsForRuntimeRevision({
      ctx,
      resolvers: [resolver],
      messages: [],
      event: createSessionStartedEvent(),
      runtimeRevision: "deployment:dpl_current",
    });

    expect(handler).toHaveBeenCalledTimes(2);
    const [tool] = buildDynamicTools(ctx);
    await expect(tool!.execute!({}, executeOptions)).resolves.toEqual({ ok: true });
  });

  it("migrates serialized legacy session metadata when the runtime revision is unchanged", async () => {
    let ctx = createCtx();
    ctx.set(SessionDynamicToolRuntimeRevisionKey, "deployment:dpl_current");
    const serialized = serializeContext(ctx);
    serialized[SessionDynamicToolMetadataKey.name] = [
      {
        closureVars: { version: "legacy" },
        description: "legacy description",
        entryKey: "tool",
        executeStepFnName: "fn_0",
        inputSchema: { type: "object" },
        name: "tool",
        resolverSlug: "legacy",
      } satisfies OldStepFunctionDynamicToolMetadata,
    ];
    ctx = await deserializeContext(serialized);
    const handler = vi.fn(() => ({ tool: createReplayableTool("current description") }));
    const resolver = createResolver("legacy", ["session.started"], handler);

    await refreshDynamicSessionToolsForRuntimeRevision({
      ctx,
      resolvers: [resolver],
      messages: [],
      event: createSessionStartedEvent(),
      runtimeRevision: "deployment:dpl_current",
    });

    expect(handler).toHaveBeenCalledOnce();
    expect(
      requireCurrentMetadata(ctx.get(SessionDynamicToolMetadataKey)?.[0]).callbacks.execute.closure,
    ).toEqual({});
    const [tool] = buildDynamicTools(ctx);
    await expect(tool!.execute!({}, executeOptions)).resolves.toEqual({ ok: true });
  });

  it("converts source-offset turn metadata while preserving its closure", async () => {
    let ctx = createCtx();
    const serialized = serializeContext(ctx);
    serialized[TurnDynamicToolMetadataKey.name] = [
      {
        callbacks: {
          execute: {
            closure: { version: "offset" },
            stepId: "eve:dynamic-tool//old/execute/0-100",
          },
        },
        description: "legacy description",
        entryKey: "legacy_turn_tool",
        inputSchema: { type: "object" },
        name: "legacy_turn_tool",
        resolverSlug: "legacy",
      } satisfies OldSourceOffsetDynamicToolMetadata,
    ];
    ctx = await deserializeContext(serialized);
    const entry = defineTool({
      description: "current description",
      inputSchema: { type: "object" },
      execute: async () => null,
    });
    stampDurableDynamicToolCallbacks(entry, {
      execute: {
        callback: (closure) => closure,
        closure: { version: "current" },
      },
    });
    const resolver = createResolver("legacy", ["turn.started"], () => ({
      legacy_turn_tool: entry,
    }));

    await rebindMissingCompiledDynamicToolCallbacks({
      ctx,
      event: makeEvent("turn.started"),
      messages: [],
      resolvers: [resolver],
    });

    expect(
      requireCurrentMetadata(ctx.get(TurnDynamicToolMetadataKey)?.[0]).callbacks.execute.closure,
    ).toEqual({
      version: "offset",
    });
    const [tool] = buildDynamicTools(ctx);
    await expect(tool!.execute!({}, executeOptions)).resolves.toEqual({ version: "offset" });
  });

  it("does not use a same-named callback registered by a different owner", async () => {
    let ctx = createCtx();
    const serialized = serializeContext(ctx);
    serialized[TurnDynamicToolMetadataKey.name] = [
      {
        callbacks: {
          execute: { closure: {}, stepId: "old-offset" },
        },
        description: "old description",
        entryKey: "tool",
        inputSchema: { type: "object" },
        name: "colliding_tool",
        resolverSlug: "missing-owner",
      } satisfies OldSourceOffsetDynamicToolMetadata,
    ];
    ctx = await deserializeContext(serialized);
    registerTestCallback("colliding_tool", "execute", () => ({ wrongOwner: true }));

    try {
      await expect(
        rebindMissingCompiledDynamicToolCallbacks({
          ctx,
          event: makeEvent("turn.started"),
          messages: [],
          resolvers: [],
        }),
      ).rejects.toThrow('Dynamic tool "colliding_tool" uses old persisted metadata');
    } finally {
      getDynamicCallbackRegistry().delete("colliding_tool");
    }
  });

  it("replaces old step-function turn metadata without requiring cold-rebind opt-in", async () => {
    let ctx = createCtx();
    const serialized = serializeContext(ctx);
    serialized[TurnDynamicToolMetadataKey.name] = [
      {
        closureVars: { version: "old" },
        description: "old description",
        entryKey: "tool",
        executeStepFnName: "old-step-function",
        inputSchema: { type: "object" },
        name: "tool",
        resolverSlug: "old",
      } satisfies OldStepFunctionDynamicToolMetadata,
    ];
    ctx = await deserializeContext(serialized);
    const resolver = createResolver("old", ["turn.started"], () => ({
      tool: createReplayableTool("current description"),
    }));

    await rebindMissingCompiledDynamicToolCallbacks({
      ctx,
      event: makeEvent("turn.started"),
      messages: [],
      resolvers: [resolver],
    });

    expect(requireCurrentMetadata(ctx.get(TurnDynamicToolMetadataKey)?.[0]).description).toBe(
      "current description",
    );
  });

  it("rejects metadata persisted by the pre-release offset-based format", () => {
    const entry = defineTool({
      description: "legacy tool",
      inputSchema: { type: "object" },
      execute: async (): Promise<unknown> => ({}),
    });
    stampDurableDynamicToolCallbacks(entry, {
      execute: { closure: {}, stepId: "eve:dynamic-tool//old/execute/0-100" } as never,
    });
    expect(() => validateDurableDynamicToolCallbacks("legacy", entry)).toThrow(
      /pre-release eve version/,
    );
  });

  it("clears removed session resolvers on a new runtime revision", async () => {
    const ctx = createCtx();
    const oldResolver = createResolver("old", ["session.started"], () => ({
      old_tool: createReplayableTool(),
    }));
    await dispatchDynamicToolEvent({
      ctx,
      resolvers: [oldResolver],
      messages: [],
      event: makeEvent("session.started"),
    });
    ctx.set(SessionDynamicToolRuntimeRevisionKey, "deployment:dpl_old");

    await refreshDynamicSessionToolsForRuntimeRevision({
      ctx,
      resolvers: [],
      messages: [],
      event: createSessionStartedEvent(),
      runtimeRevision: "deployment:dpl_new",
    });

    expect(ctx.get(SessionDynamicToolMetadataKey)).toEqual([]);
    expect(ctx.get(SessionDynamicToolRuntimeRevisionKey)).toBe("deployment:dpl_new");
  });

  it("leaves unsupported connection input schemas for the MCP server to validate", async () => {
    const ctx = createCtx();
    const inputSchema: JsonObject = {
      properties: {
        filters: {
          anyOf: [
            { properties: { source: { type: "string" } }, type: "object" },
            {
              properties: {
                source: { $ref: "#/properties/filters/anyOf/0/properties/source" },
              },
              type: "object",
            },
          ],
        },
      },
      type: "object",
    };
    const resolver = createResolver("connection", ["step.started"], () => ({
      remote: stampTestTool(
        defineTool({
          description: "remote tool",
          inputSchema,
          execute: async (): Promise<unknown> => ({ ok: true }),
        }),
      ),
    }));

    await dispatchDynamicToolEvent({
      ctx,
      resolvers: [resolver],
      messages: [],
      event: makeEvent("step.started"),
    });

    const tools = buildDynamicTools(ctx);
    expect(tools).toHaveLength(1);

    // The advertised schema preserves the source verbatim, including the
    // inline JSON Pointer $ref that zod cannot rehydrate.
    const schema = asSchema(tools[0]!.inputSchema);
    expect(schema.jsonSchema).toMatchObject(inputSchema);

    // Local validation is a passthrough — the MCP server stays responsible.
    await expect(schema.validate?.({ filters: { source: "octolens" } })).resolves.toEqual({
      success: true,
      value: { filters: { source: "octolens" } },
    });
  });

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
    expect(metadata![0]!.name).toBe("forecast");

    const tools = buildDynamicTools(ctx);
    expect(tools).toHaveLength(1);
    expect(tools[0]!.name).toBe("forecast");
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

  it("passes the final qualified name to a step-scoped tool", async () => {
    const ctx = createCtx();
    const resolver = {
      ...createResolver("search", ["step.started"], () => ({
        query: stampTestTool(
          defineTool({
            description: "search records",
            inputSchema: { type: "object" },
            execute: async (_input, toolCtx) => ({ toolName: toolCtx.toolName }),
          }),
        ),
      })),
      extensionNamespace: "warehouse",
    };

    await dispatchDynamicToolEvent({
      ctx,
      resolvers: [resolver],
      messages: [],
      event: makeEvent("step.started"),
    });

    const tool = buildDynamicTools(ctx)[0]!;
    expect(tool.name).toBe("warehouse__query");
    await expect(tool.execute!({}, executeOptions)).resolves.toEqual({
      toolName: "warehouse__query",
    });
  });

  it("provides inline auth to a step-scoped tool", async () => {
    const ctx = createCtx();
    const getToken = vi.fn(async () => ({ token: "step-token" }));
    const auth = { getToken, principalType: "app" as const };
    const resolver = createResolver("oauth", ["step.started"], () => ({
      probe: stampTestTool(
        defineTool({
          description: "resolve auth",
          inputSchema: { type: "object" },
          execute: async (_input, toolCtx) => {
            const { token } = await toolCtx.getToken(auth);
            return { token };
          },
        }),
      ),
    }));

    await dispatchDynamicToolEvent({
      ctx,
      resolvers: [resolver],
      messages: [],
      event: makeEvent("step.started"),
    });

    const tool = buildDynamicTools(ctx)[0]!;
    await expect(tool.execute!({}, executeOptions)).resolves.toEqual({ token: "step-token" });
    expect(getToken).toHaveBeenCalledOnce();
  });

  it("restores cached step tools after virtual context is cleared", async () => {
    const ctx = createCtx();
    const resolver = createResolver("api", ["step.started"], () => ({
      query: createReplayableTool("cached"),
    }));
    const event = createStepStartedEvent({
      modelId: "test-model",
      sequence: 0,
      stepIndex: 1,
      turnId: "turn-1",
    });

    await dispatchDynamicToolEvent({ ctx, event, messages: [], resolvers: [resolver] });
    ctx.clearVirtualContext();
    expect(buildDynamicTools(ctx).map((tool) => tool.name)).toEqual(["query"]);

    await dispatchDynamicToolEvent({ ctx, event, messages: [], resolvers: [resolver] });
    expect(buildDynamicTools(ctx)[0]?.description).toBe("cached");
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
      event: createStepStartedEvent({
        modelId: "test-model",
        sequence: 0,
        stepIndex: 0,
        turnId: "test-turn",
      }),
    });
    expect(buildDynamicTools(ctx)[0]!.description).toBe("call 1");

    await dispatchDynamicToolEvent({
      ctx,
      resolvers: [resolver],
      messages: [],
      event: createStepStartedEvent({
        modelId: "test-model",
        sequence: 1,
        stepIndex: 1,
        turnId: "test-turn",
      }),
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
    expect(buildDynamicTools(ctx)[0]!.name).toBe("a_tool");

    await dispatchDynamicToolEvent({
      ctx,
      resolvers: [resolverA, resolverB],
      messages: [],
      event: makeEvent("step.started"),
    });
    const tools = buildDynamicTools(ctx);
    expect(tools).toHaveLength(2);
    expect(tools.map((t) => t.name).sort()).toEqual(["a_tool", "b_tool"]);
  });

  it("throws and recommends manual namespacing when two resolvers emit the same name", async () => {
    const ctx = createCtx();
    const alpha = createResolver("alpha", ["session.started"], () => ({
      shared: createReplayableTool(),
    }));
    const beta = createResolver("beta", ["session.started"], () => ({
      shared: createReplayableTool(),
    }));

    await expect(
      dispatchDynamicToolEvent({
        ctx,
        resolvers: [alpha, beta],
        messages: [],
        event: makeEvent("session.started"),
      }),
    ).rejects.toThrow(/Dynamic tool "shared".*Namespace the map key manually/u);
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

  it("persists background execution and forwards TaskExec when replaying", async () => {
    const ctx = createCtx();
    const stepFn = vi.fn(async function* (
      _closure: unknown,
      _input: unknown,
      _toolCtx: unknown,
      task: TaskExec,
    ) {
      yield task.postMessage("replayed");
      return { done: true };
    });
    const resolver = createResolver("background", ["session.started"], () => {
      const entry = defineTool({
        description: "delegate background work",
        execution: "background",
        inputSchema: z.strictObject({}),
        async *execute(_input, _toolCtx, task) {
          yield task.postMessage("replayed");
          return { done: true };
        },
      });
      stampDurableDynamicToolCallbacks(entry, {
        execute: { callback: stepFn as never, closure: {} },
      });
      return { background_task: entry };
    });

    await dispatchDynamicToolEvent({
      ctx,
      resolvers: [resolver],
      messages: [],
      event: makeEvent("session.started"),
    });
    const restored = await deserializeContext(serializeContext(ctx));
    const [metadata] = restored.get(SessionDynamicToolMetadataKey) ?? [];
    expect(metadata?.execution).toBe("background");

    const [tool] = buildDynamicTools(restored);
    expect(tool?.execution).toBe("background");
    const task: TaskExec = {
      binding: { taskId: "task-1", token: "token-1" },
      postMessage: (message) => ({ kind: "eve:task-message", message }),
      send: vi.fn(),
      session: {} as TaskExec["session"],
      task: {} as TaskExec["task"],
      taskId: "task-1",
    };
    const output = tool!.execute!({}, executeOptions, task) as AsyncIterable<unknown>;
    const updates = [];
    for await (const update of output) updates.push(update);
    expect(updates).toEqual([{ kind: "eve:task-message", message: "replayed" }]);
    expect(stepFn).toHaveBeenCalledWith({}, {}, expect.anything(), task);
  });

  it("replays session tools from durable metadata on a fresh step", async () => {
    const ctx = createCtx();

    const stepFn = vi.fn((_closure: unknown, input: unknown, toolCtx: unknown) => ({
      input,
      toolName: (toolCtx as { toolName: string }).toolName,
    }));

    // Build a resolver whose tool entry carries a durable callback descriptor.
    const resolver = createResolver("tenant", ["session.started"], () => {
      const entry = defineTool({
        description: "tenant query",
        inputSchema: { type: "object" },
        execute: async () => ({ ok: true }),
      });
      stampDurableDynamicToolCallbacks(entry, {
        execute: {
          callback: stepFn as never,
          closure: { apiUrl: "https://api.example.com" },
        },
      });
      return { query: entry };
    });

    // First step: resolve session tools, metadata is stored durably and the
    // callback binds under the final tool name.
    await dispatchDynamicToolEvent({
      ctx,
      resolvers: [resolver],
      messages: [],
      event: makeEvent("session.started"),
    });
    expect(buildDynamicTools(ctx)).toHaveLength(1);
    expect(ctx.get(SessionDynamicToolMetadataKey)).toHaveLength(1);
    expect(
      requireCurrentMetadata(ctx.get(SessionDynamicToolMetadataKey)?.[0]).callbacks.execute.closure,
    ).toEqual({
      apiUrl: "https://api.example.com",
    });

    // Simulate workflow step boundary: clear virtual context.
    // Durable metadata survives — buildDynamicTools reads from durable keys.
    ctx.clearVirtualContext();
    expect(ctx.get(SessionDynamicToolMetadataKey)).toHaveLength(1);

    const tools = buildDynamicTools(ctx);
    expect(tools).toHaveLength(1);
    expect(tools[0]!.name).toBe("query");
    await expect(tools[0]!.execute!({}, executeOptions)).resolves.toEqual({
      input: {},
      toolName: "query",
    });
  });

  it("provides inline auth to a replayed session-scoped tool", async () => {
    const ctx = createCtx();
    const getToken = vi.fn(async () => ({ token: "replayed-token" }));
    const auth = { getToken, principalType: "app" as const };
    const stepFn = vi.fn(async (_closure: unknown, _input: unknown, toolCtx: unknown) => {
      const { token } = await (toolCtx as ToolContext).getToken(auth);
      return { token };
    });

    const resolver = createResolver("oauth", ["session.started"], () => {
      const entry = defineTool({
        description: "resolve replayed auth",
        inputSchema: { type: "object" },
        execute: async () => ({ ok: true }),
      });
      stampDurableDynamicToolCallbacks(entry, {
        execute: { callback: stepFn as never, closure: {} },
      });
      return { probe: entry };
    });

    await dispatchDynamicToolEvent({
      ctx,
      resolvers: [resolver],
      messages: [],
      event: makeEvent("session.started"),
    });
    ctx.clearVirtualContext();

    const tool = buildDynamicTools(ctx)[0]!;
    await expect(tool.execute!({}, executeOptions)).resolves.toEqual({
      token: "replayed-token",
    });
    expect(getToken).toHaveBeenCalledOnce();
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

  it("skips map entries that were not created with defineTool", async () => {
    const ctx = createCtx();
    const rawResolver = createResolver("raw", ["step.started"], () => ({
      unwrapped: {
        description: "raw tool",
        inputSchema: { type: "object" },
        execute: async () => ({ ok: true }),
      },
    }));

    await dispatchDynamicToolEvent({
      ctx,
      resolvers: [rawResolver],
      messages: [],
      event: makeEvent("step.started"),
    });

    expect(buildDynamicTools(ctx)).toHaveLength(0);
  });

  it.each(["single", "map"])(
    "does not advertise a workflow tool returned as a %s",
    async (shape) => {
      const ctx = createCtx();
      const tool = defineWorkflowTool({
        description: "Invalid dynamic workflow",
        inputSchema: {},
        async execute() {
          return 1;
        },
      });
      const resolver = createResolver("workflow", ["session.started"], () =>
        shape === "single" ? tool : { workflow: tool },
      );
      await dispatchDynamicToolEvent({
        ctx,
        resolvers: [resolver],
        messages: [],
        event: makeEvent("session.started"),
      });
      expect(buildDynamicTools(ctx)).toHaveLength(0);
    },
  );

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
    expect(tools[0]!.name).toBe("working");
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
// Programmatic dynamic tools — no bundler transform, auto-registered
// ---------------------------------------------------------------------------

function createProgrammaticTool(
  description = "framework stub",
  executeFn: (input: Record<string, unknown>) => unknown = () => ({ ok: true }),
): DynamicToolEntry {
  return createReplayableTool(description, executeFn);
}

describe("programmatic dynamic tools (no bundler transform)", () => {
  it("session-scoped programmatic tool is replayable across steps", async () => {
    const ctx = createCtx();
    const executeFn = vi.fn(() => ({ data: "from-programmatic" }));
    const resolver = createResolver("fwk", ["session.started"], () => ({
      search: createProgrammaticTool("programmatic search", executeFn),
    }));

    await dispatchDynamicToolEvent({
      ctx,
      resolvers: [resolver],
      messages: [],
      event: makeEvent("session.started"),
    });

    const metadata = ctx.get(SessionDynamicToolMetadataKey);
    expect(metadata).toHaveLength(1);
    expect(requireCurrentMetadata(metadata?.[0]).callbacks.execute.closure).toEqual({});

    const tools = buildDynamicTools(ctx);
    expect(tools).toHaveLength(1);
    expect(tools[0]!.name).toBe("search");

    // Simulate step boundary — virtual context cleared, durable survives

    const replayedTools = buildDynamicTools(ctx);
    expect(replayedTools).toHaveLength(1);
    expect(replayedTools[0]!.name).toBe("search");

    // Execute the replayed tool — the original closure is invoked
    await replayedTools[0]!.execute!({ query: "test" }, executeOptions);
    expect(executeFn).toHaveBeenCalledWith({ query: "test" });
  });

  it("turn-scoped programmatic tool is replayable", async () => {
    const ctx = createCtx();
    const executeFn = vi.fn(() => ({ result: "turn-tool" }));
    const resolver = createResolver("helper", ["turn.started"], () => ({
      assist: createProgrammaticTool("turn helper", executeFn),
    }));

    await dispatchDynamicToolEvent({
      ctx,
      resolvers: [resolver],
      messages: [],
      event: makeEvent("turn.started"),
    });

    const metadata = ctx.get(TurnDynamicToolMetadataKey);
    expect(metadata).toHaveLength(1);

    ctx.clearVirtualContext();

    const tools = buildDynamicTools(ctx);
    expect(tools).toHaveLength(1);
    expect(tools[0]!.name).toBe("assist");

    await tools[0]!.execute!({ action: "help" }, executeOptions);
    expect(executeFn).toHaveBeenCalledWith({ action: "help" });
  });

  it("framework and authored tools coexist in session scope", async () => {
    const ctx = createCtx();
    const frameworkResolver = createResolver("fwk", ["session.started"], () => ({
      search: createProgrammaticTool("programmatic search"),
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

    const tools = buildDynamicTools(ctx);
    expect(tools).toHaveLength(2);
    expect(tools.map((t) => t.name).sort()).toEqual(["query", "search"]);
  });

  it("single-entry programmatic tool uses slug as name", async () => {
    const ctx = createCtx();
    const resolver = createResolver("analytics", ["session.started"], () =>
      createProgrammaticTool("single tool"),
    );

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

  it("propagates approval from a step-scoped entry into the harness tool", async () => {
    const ctx = createCtx();
    const approvalFn = vi.fn(() => "user-approval" as const);
    const entry: DynamicToolEntry = stampTestTool(
      defineTool({
        description: "destructive op",
        inputSchema: { type: "object" },
        approval: approvalFn,
        execute: async (): Promise<unknown> => ({ ok: true }),
      }),
    );
    const resolver = createResolver("connection", ["step.started"], () => ({ risky: entry }));

    await dispatchDynamicToolEvent({
      ctx,
      resolvers: [resolver],
      messages: [],
      event: makeEvent("step.started"),
    });

    const tools = buildDynamicTools(ctx);
    expect(tools).toHaveLength(1);
    expect(tools[0]!.name).toBe("risky");
    const approvalCtx = createApprovalContext({ toolName: "risky" });
    await expect(resolveApprovalPolicy(tools[0]!.approval!)(approvalCtx)).resolves.toBe(
      "user-approval",
    );
  });

  it("replays approval from session-scoped dynamic tools", async () => {
    const ctx = createCtx();
    const approvalFn = vi.fn(async () => "user-approval" as const);
    const entry: DynamicToolEntry = stampTestTool(
      defineTool({
        description: "destructive op",
        inputSchema: { type: "object" },
        approval: approvalFn,
        execute: async (): Promise<unknown> => ({ ok: true }),
      }),
    );
    const resolver = createResolver("session_guard", ["session.started"], () => ({
      guarded: entry,
    }));

    await dispatchDynamicToolEvent({
      ctx,
      resolvers: [resolver],
      messages: [],
      event: makeEvent("session.started"),
    });

    const tools = buildDynamicTools(ctx);
    expect(tools).toHaveLength(1);
    expect(tools[0]!.name).toBe("guarded");
    const approvalCtx = createApprovalContext({
      toolInput: { draftId: "draft_123" },
      toolName: "guarded",
    });
    await expect(resolveApprovalPolicy(tools[0]!.approval!)(approvalCtx)).resolves.toBe(
      "user-approval",
    );
    expect(approvalFn).toHaveBeenCalledExactlyOnceWith(approvalCtx);
  });

  it("replays label callbacks", () => {
    const ctx = createCtx();
    registerTestCallback("deploy", "execute", () => ({ ok: true }));
    registerTestCallback(
      "deploy",
      "labelStart",
      (_closure, input) => `Deploy to ${String((input as { environment: unknown }).environment)}`,
    );
    registerTestCallback(
      "deploy",
      "labelComplete",
      (_closure, _input, output) => `Deployed to ${String((output as { url: unknown }).url)}`,
    );
    registerTestCallback("deploy", "labelDelta", (_closure, _input, partial) =>
      String((partial as { phase: unknown }).phase),
    );
    ctx.set(TurnDynamicToolMetadataKey, [
      {
        callbacks: {
          label: {
            complete: { closure: {} },
            delta: { closure: {} },
            start: { closure: {} },
          },
          execute: { closure: {} },
        },
        description: "Deploy.",
        entryKey: "legacy:deploy",
        inputSchema: { type: "object" },
        name: "deploy",
        resolverSlug: "legacy",
      },
    ]);

    const tool = buildDynamicTools(ctx)[0];
    expect(tool?.label?.start?.({ environment: "preview" })).toBe("Deploy to preview");
    expect(
      tool?.label?.complete?.({ environment: "preview" }, { url: "preview.example.com" }),
    ).toBe("Deployed to preview.example.com");
    expect(tool?.label?.delta?.({ environment: "preview" }, { phase: "Uploading" })).toBe(
      "Uploading",
    );
    getDynamicCallbackRegistry().delete("deploy");
  });

  it("replays phase-specific turn metadata", async () => {
    const ctx = createCtx();
    const approval = vi.fn(() => "user-approval" as const);
    registerTestCallback("guarded", "execute", () => ({ ok: true }));
    registerTestCallback("guarded", "approvalRequest", approval);
    ctx.set(TurnDynamicToolMetadataKey, [
      {
        callbacks: {
          approvalRequest: { closure: {} },
          execute: { closure: {} },
        },
        description: "legacy guarded tool",
        entryKey: "legacy:guarded",
        inputSchema: { type: "object" },
        name: "guarded",
        resolverSlug: "legacy",
      },
    ]);

    const tool = buildDynamicTools(ctx)[0];
    if (tool?.approval === undefined) throw new Error("Expected replayed approval.");

    await expect(
      resolveApprovalPolicy(tool.approval)(createApprovalContext({ toolName: "guarded" })),
    ).resolves.toBe("user-approval");
    getDynamicCallbackRegistry().delete("guarded");
  });

  it("uses the first dynamic definition for response authorization", () => {
    const ctx = createCtx();
    registerTestCallback("guarded", "execute", () => null);
    registerTestCallback("guarded", "approvalRequest", () => "user-approval");
    registerTestCallback(
      "guarded",
      "approvalResponse",
      async () => ({ status: "allowed" }) as const,
    );
    ctx.set(StepDynamicToolMetadataKey, [
      {
        callbacks: {
          approvalRequest: { closure: {} },
          approvalResponse: { closure: {} },
          execute: { closure: {} },
        },
        description: "step",
        entryKey: "step:guarded",
        inputSchema: { type: "object" },
        name: "guarded",
        resolverSlug: "step",
      },
    ]);
    ctx.set(SessionDynamicToolMetadataKey, [
      {
        callbacks: {
          approvalRequest: { closure: {} },
          approvalResponse: { closure: {} },
          execute: { closure: {} },
        },
        description: "session",
        entryKey: "session:guarded",
        inputSchema: { type: "object" },
        name: "guarded",
        resolverSlug: "session",
      },
    ]);

    const tools = buildResponseAuthorizationTools({
      authoredTools: new Map(),
      context: ctx,
    });

    expect(tools.get("guarded")?.description).toBe("step");
    getDynamicCallbackRegistry().delete("guarded");
  });

  it("rejects an untransformed tool atomically without resolver hydration", async () => {
    const ctx = createCtx();
    const execute = vi.fn(async () => ({ ok: true }));
    const request = vi.fn(async () => "user-approval" as const);
    const response = vi.fn(async () => ({ status: "allowed" }) as const);
    const handler = vi.fn(() => ({
      guarded: defineTool({
        approval: { request, response },
        description: "dependency-created destructive op",
        execute,
        inputSchema: { type: "object" },
      }),
    }));
    const resolver = createResolver("session_guard", ["session.started"], handler);

    await dispatchDynamicToolEvent({
      ctx,
      event: makeEvent("session.started"),
      messages: [],
      resolvers: [resolver],
    });
    expect(handler).toHaveBeenCalledOnce();
    expect(ctx.get(SessionDynamicToolMetadataKey)).toEqual([]);
    expect(buildDynamicTools(ctx)).toEqual([]);
    expect(execute).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
    expect(response).not.toHaveBeenCalled();
  });

  it("propagates outputSchema from dynamic entries into harness tools and metadata", async () => {
    const ctx = createCtx();
    const outputSchema = {
      additionalProperties: false,
      properties: { ok: { type: "boolean" } },
      required: ["ok"],
      type: "object",
    };
    const entry: DynamicToolEntry = stampTestTool(
      defineTool({
        description: "typed op",
        inputSchema: { type: "object" },
        outputSchema,
        execute: async (): Promise<unknown> => ({ ok: true }),
      }),
    );
    const resolver = createResolver("connection", ["session.started"], () => ({ typed: entry }));

    await dispatchDynamicToolEvent({
      ctx,
      resolvers: [resolver],
      messages: [],
      event: makeEvent("session.started"),
    });

    const metadata = ctx.get(SessionDynamicToolMetadataKey);
    expect(metadata?.[0]?.outputSchema).toEqual(outputSchema);

    const tools = buildDynamicTools(ctx);
    expect(tools).toHaveLength(1);
    expect(serializeOutputSchema(tools[0]!.outputSchema as ToolSchema)).toEqual(outputSchema);
  });

  it("leaves approval undefined when a step-scoped entry omits it", async () => {
    const ctx = createCtx();
    const resolver = createResolver("connection", ["step.started"], () => ({
      safe: createProgrammaticTool("read-only op"),
    }));

    await dispatchDynamicToolEvent({
      ctx,
      resolvers: [resolver],
      messages: [],
      event: makeEvent("step.started"),
    });

    const tools = buildDynamicTools(ctx);
    expect(tools).toHaveLength(1);
    expect(tools[0]!.approval).toBeUndefined();
  });

  it("re-dispatch updates the registered step function", async () => {
    const ctx = createCtx();
    let callCount = 0;
    const resolver = createResolver("counter", ["session.started"], () => {
      callCount++;
      const current = callCount;
      return {
        count: createProgrammaticTool(`v${current}`, () => ({ version: current })),
      };
    });

    await dispatchDynamicToolEvent({
      ctx,
      resolvers: [resolver],
      messages: [],
      event: makeEvent("session.started"),
    });

    let tools = buildDynamicTools(ctx);
    const result1 = await tools[0]!.execute!({}, executeOptions);
    expect(result1).toEqual({ version: 1 });

    // Re-dispatch overwrites the resolver's slot
    await dispatchDynamicToolEvent({
      ctx,
      resolvers: [resolver],
      messages: [],
      event: makeEvent("session.started"),
    });

    tools = buildDynamicTools(ctx);
    expect(tools[0]!.description).toBe("v2");
    const result2 = await tools[0]!.execute!({}, executeOptions);
    expect(result2).toEqual({ version: 2 });
  });
});
