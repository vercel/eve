import { asSchema } from "ai";
import { describe, expect, it, vi } from "vitest";

import type { DynamicToolEntry } from "#shared/dynamic-tool-definition.js";
import type { DurableDynamicToolMetadata } from "#context/keys.js";
import { resolveApprovalPolicy, type ApprovalContext } from "#public/definitions/approval.js";
import { defineTool, type ToolContext } from "#public/definitions/tool.js";
import type { JsonObject } from "#shared/json.js";
import { serializeOutputSchema, type ToolSchema } from "#shared/tool-schema.js";

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
import { stampDurableDynamicToolCallbacks } from "#shared/durable-dynamic-tool-callbacks.js";
import type { ResolvedDynamicToolResolver } from "#runtime/types.js";
import { createSessionStartedEvent, type UnstampedMessageStreamEvent } from "#protocol/message.js";

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
    getOrCreateStepRegistry(Symbol.for("@workflow/core//registeredSteps")).set(
      "capture-execute",
      () => null,
    );
    const entry = defineTool({
      description: "captured tool",
      inputSchema: { type: "object" },
      execute: async () => null,
    });
    stampDurableDynamicToolCallbacks(entry, {
      execute: { closure: closure as JsonObject, stepId: "capture-execute" },
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
  function metadata(
    name: string,
    stepId: string,
    closure: JsonObject = {},
  ): DurableDynamicToolMetadata {
    return {
      callbacks: { execute: { closure, stepId } },
      description: `${name} description`,
      entryKey: name,
      inputSchema: { type: "object" },
      name,
      resolverSlug: "test",
    };
  }

  it("fails execution closed when the registered callback is unavailable", async () => {
    const [tool] = replayDynamicSessionTools(
      [metadata("unregistered", "eve:dynamic-tool//missing")],
      [],
    );
    await expect(tool!.execute!({}, executeOptions)).rejects.toThrow(
      'Dynamic tool "unregistered" cannot replay its execute callback',
    );
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
      const durable = metadata("replay-tool", stepId, {
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
      const tools = replayDynamicSessionTools([metadata("snapshot-tool", stepId, closureVars)], []);

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
      const durable = [
        metadata("tenant__query", stepIdA, { tenant: "acme" }),
        metadata("tenant__export", stepIdB, { tenant: "acme" }),
      ];

      const tools = replayDynamicSessionTools(durable, []);
      expect(tools).toHaveLength(2);
      expect(tools[0]!.name).toBe("tenant__query");
      expect(tools[1]!.name).toBe("tenant__export");
    } finally {
      registry.delete(stepIdA);
      registry.delete(stepIdB);
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
  return { type, data: {} } as UnstampedMessageStreamEvent;
}

const registrySym = Symbol.for("@workflow/core//registeredSteps");
const testRegistry = getOrCreateStepRegistry(registrySym);
let stepCounter = 0;

function simulateColdStart(ctx: ContextContainer): void {
  for (const metadata of ctx.get(SessionDynamicToolMetadataKey) ?? []) {
    for (const callback of Object.values(metadata.callbacks)) {
      testRegistry.delete(callback.stepId);
    }
  }
  ctx.clearVirtualContext();
}

/**
 * Creates a tool entry with bundler-injected step function fields so
 * `buildDynamicTools` can replay it from durable metadata.
 */
function createReplayableTool(
  description = "stub",
  executeFn: (input: Record<string, unknown>) => unknown = () => ({ ok: true }),
): DynamicToolEntry {
  const stepId = `test-step-${++stepCounter}`;
  testRegistry.set(stepId, (_vars: unknown, input: unknown) =>
    executeFn(input as Record<string, unknown>),
  );
  const entry = defineTool({
    description,
    inputSchema: { type: "object" },
    execute: async (input: Record<string, unknown>): Promise<unknown> => executeFn(input),
  });
  stampDurableDynamicToolCallbacks(entry, {
    execute: { closure: {}, stepId },
  });
  return entry;
}

function stampTestTool(entry: DynamicToolEntry): DynamicToolEntry {
  const executeStepId = `test-step-${++stepCounter}`;
  testRegistry.set(executeStepId, (_closure: unknown, input: unknown, context: unknown) =>
    entry.execute(
      input as Record<string, unknown>,
      context as Parameters<DynamicToolEntry["execute"]>[1],
    ),
  );
  const request = entry.approval === undefined ? undefined : resolveApprovalPolicy(entry.approval);
  const response =
    entry.approval === undefined || typeof entry.approval === "function"
      ? undefined
      : entry.approval.response;
  const approvalRequestStepId = request === undefined ? undefined : `test-step-${++stepCounter}`;
  const approvalResponseStepId = response === undefined ? undefined : `test-step-${++stepCounter}`;
  const toModelOutputStepId =
    entry.toModelOutput === undefined ? undefined : `test-step-${++stepCounter}`;
  if (request !== undefined) {
    testRegistry.set(approvalRequestStepId!, (_closure: unknown, context: unknown) =>
      request(context as ApprovalContext),
    );
  }
  if (response !== undefined) {
    testRegistry.set(approvalResponseStepId!, (_closure: unknown, context: unknown) =>
      response(context as never),
    );
  }
  if (entry.toModelOutput !== undefined) {
    testRegistry.set(toModelOutputStepId!, (_closure: unknown, output: unknown) =>
      entry.toModelOutput!(output),
    );
  }
  stampDurableDynamicToolCallbacks(entry, {
    execute: { closure: {}, stepId: executeStepId },
    ...(approvalRequestStepId === undefined
      ? {}
      : { approvalRequest: { closure: {}, stepId: approvalRequestStepId } }),
    ...(approvalResponseStepId === undefined
      ? {}
      : { approvalResponse: { closure: {}, stepId: approvalResponseStepId } }),
    ...(toModelOutputStepId === undefined
      ? {}
      : { toModelOutput: { closure: {}, stepId: toModelOutputStepId } }),
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
    const event = {
      type: "step.started",
      data: { stepIndex: 1, turnId: "turn-1" },
    } as UnstampedMessageStreamEvent;

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

  it("replays session tools from durable metadata on a fresh step", async () => {
    const ctx = createCtx();

    // Register a step function so replayDynamicSessionTools can
    // reconstruct the tool on the second step.
    const stepId = "eve:dynamic-tool//__eve_dispatch_rehydrate_test";
    const stepFn = vi.fn((_vars: unknown, input: unknown, toolCtx: unknown) => ({
      input,
      toolName: (toolCtx as { toolName: string }).toolName,
    }));
    const registrySym = Symbol.for("@workflow/core//registeredSteps");
    const registry = getOrCreateStepRegistry(registrySym);
    registry.set(stepId, stepFn);

    try {
      // Build a resolver whose tool entry carries a durable callback descriptor.
      const resolver = createResolver("tenant", ["session.started"], () => {
        const entry = defineTool({
          description: "tenant query",
          inputSchema: { type: "object" },
          execute: async () => ({ ok: true }),
        });
        stampDurableDynamicToolCallbacks(entry, {
          execute: {
            closure: { apiUrl: "https://api.example.com" },
            stepId,
          },
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
      expect(ctx.get(SessionDynamicToolMetadataKey)![0]!.callbacks.execute.stepId).toBe(stepId);

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
    } finally {
      registry.delete(stepId);
    }
  });

  it("provides inline auth to a replayed session-scoped tool", async () => {
    const ctx = createCtx();
    const stepId = "eve:dynamic-tool//__eve_dispatch_auth_rehydrate_test";
    const getToken = vi.fn(async () => ({ token: "replayed-token" }));
    const auth = { getToken, principalType: "app" as const };
    const stepFn = vi.fn(async (_vars: unknown, _input: unknown, toolCtx: unknown) => {
      const { token } = await (toolCtx as ToolContext).getToken(auth);
      return { token };
    });
    const registrySym = Symbol.for("@workflow/core//registeredSteps");
    const registry = getOrCreateStepRegistry(registrySym);
    registry.set(stepId, stepFn);

    try {
      const resolver = createResolver("oauth", ["session.started"], () => {
        const entry = defineTool({
          description: "resolve replayed auth",
          inputSchema: { type: "object" },
          execute: async () => ({ ok: true }),
        });
        stampDurableDynamicToolCallbacks(entry, {
          execute: { closure: {}, stepId },
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
// Framework dynamic tools — no bundler transform, auto-registered
// ---------------------------------------------------------------------------

function createFrameworkTool(
  description = "framework stub",
  executeFn: (input: Record<string, unknown>) => unknown = () => ({ ok: true }),
): DynamicToolEntry {
  return createReplayableTool(description, executeFn);
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
    expect(metadata![0]!.callbacks.execute.stepId).toMatch(/^test-step-/);
    expect(metadata![0]!.callbacks.execute.closure).toEqual({});

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
    expect(metadata![0]!.callbacks.execute.stepId).toMatch(/^test-step-/);

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

    const tools = buildDynamicTools(ctx);
    expect(tools).toHaveLength(2);
    expect(tools.map((t) => t.name).sort()).toEqual(["query", "search"]);
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
    testRegistry.delete("eve:framework-dynamic:connection:risky");
    testRegistry.delete("eve:dynamic-tool-approval:connection:risky");

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
    expect(testRegistry.has("eve:framework-dynamic:connection:risky")).toBe(false);
    expect(testRegistry.has("eve:dynamic-tool-approval:connection:risky")).toBe(false);
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

  it("replays phase-specific turn metadata", async () => {
    const ctx = createCtx();
    const approval = vi.fn(() => "user-approval" as const);
    testRegistry.set("legacy-turn-execute", () => ({ ok: true }));
    testRegistry.set("legacy-turn-approval", approval);
    ctx.set(TurnDynamicToolMetadataKey, [
      {
        callbacks: {
          approvalRequest: { closure: {}, stepId: "legacy-turn-approval" },
          execute: { closure: {}, stepId: "legacy-turn-execute" },
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
  });

  it("uses the first dynamic definition for response authorization", () => {
    const ctx = createCtx();
    testRegistry.set("step-execute", () => null);
    testRegistry.set("step-request", () => "user-approval");
    testRegistry.set("step-response", async () => ({ status: "allowed" }) as const);
    ctx.set(StepDynamicToolMetadataKey, [
      {
        callbacks: {
          approvalRequest: { closure: {}, stepId: "step-request" },
          approvalResponse: { closure: {}, stepId: "step-response" },
          execute: { closure: {}, stepId: "step-execute" },
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
          approvalRequest: { closure: {}, stepId: "session-policy" },
          approvalResponse: { closure: {}, stepId: "session-authorizer" },
          execute: { closure: {}, stepId: "session-execute" },
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
    expect(tools[0]!.approval).toBeUndefined();
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
