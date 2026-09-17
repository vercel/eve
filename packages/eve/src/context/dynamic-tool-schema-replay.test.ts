import { describe, expect, it, vi } from "vitest";
import { z as z3 } from "zod/v3";
import { z } from "#compiled/zod/index.js";
import { ContextContainer } from "#context/container.js";
import { buildDynamicTools } from "#context/build-dynamic-tools.js";
import {
  dispatchDynamicToolEvent,
  refreshDynamicSessionToolsForRuntimeRevision,
  rebindMissingCompiledDynamicToolCallbacks,
  validateDurableDynamicToolCallbacks,
} from "#context/dynamic-tool-lifecycle.js";
import { deserializeContext, serializeContext } from "#context/serialize.js";
import {
  SessionIdKey,
  SessionDynamicToolRuntimeRevisionKey,
  StaticModelReferenceKey,
} from "#context/keys.js";
import {
  defineTool,
  type PublicToolInputSchema,
  type PublicToolOutputSchema,
} from "#tools/definition.js";
import { defineDurableSchema } from "#tools/durable-schema.js";
import { clearDurableDynamicCallbacks, defineDurableCallback } from "#tools/durable-callbacks.js";
import { isToolSchema, serializeInputSchema, type ToolSchema } from "#tools/schema.js";
import { createStepStartedEvent, type UnstampedMessageStreamEvent } from "#protocol/message.js";
import type { DynamicToolEntry } from "#tools/dynamic.js";
import type { ResolvedDynamicToolResolver } from "#runtime/types.js";

vi.mock("#context/build-callback-context.js", () => ({ buildCallbackContext: () => ({}) }));

let sequence = 0;
const executeOptions = { messages: [], toolCallId: "call_1" };
const owner = {
  sessionId: "schemas",
  scope: "session" as const,
  resolverSlug: "schema",
  entryKey: "tool",
  name: "tool",
};

function event(scope: "session" | "turn" | "step"): UnstampedMessageStreamEvent {
  return scope === "step"
    ? createStepStartedEvent({ modelId: "test", sequence: 0, stepIndex: 0, turnId: "turn" })
    : ({ type: `${scope}.started`, data: {} } as UnstampedMessageStreamEvent);
}

function tool(inputSchema: PublicToolInputSchema, outputSchema?: PublicToolOutputSchema) {
  return defineTool({
    description: "Validated tool",
    inputSchema: defineDurableSchema({ closure: {}, schema: () => inputSchema }),
    ...(outputSchema === undefined
      ? {}
      : { outputSchema: defineDurableSchema({ closure: {}, schema: () => outputSchema }) }),
    execute: defineDurableCallback({ closure: {}, callback: () => "executed" }),
  });
}

async function resolve(createTool: () => unknown, scope: "session" | "turn" | "step" = "session") {
  const ctx = new ContextContainer();
  ctx.set(SessionIdKey, `schema-session-${++sequence}`);
  ctx.set(StaticModelReferenceKey, null);
  const resolver: ResolvedDynamicToolResolver = {
    slug: "schema",
    eventNames: [`${scope}.started`],
    events: { [`${scope}.started`]: () => ({ tool: createTool() }) },
    sourceId: "test:schema",
    sourceKind: "module",
    logicalPath: "agent/tools/schema.ts",
  };
  await dispatchDynamicToolEvent({ ctx, resolvers: [resolver], event: event(scope), messages: [] });
  ctx.set(SessionDynamicToolRuntimeRevisionKey, "stable");
  return { ctx, resolver };
}

async function coldReplay(ctx: ContextContainer, resolver: ResolvedDynamicToolResolver) {
  const restored = await deserializeContext(serializeContext(ctx));
  clearDurableDynamicCallbacks(ctx.require(SessionIdKey));
  await refreshDynamicSessionToolsForRuntimeRevision({
    ctx: restored,
    resolvers: [resolver],
    event: { type: "session.started", data: {} },
    messages: [],
    runtimeRevision: "stable",
  });
  return buildDynamicTools(restored)[0]!;
}

function validate(schema: unknown, value: unknown) {
  if (!isToolSchema(schema)) throw new Error("Expected a live schema");
  return schema["~standard"].validate(value);
}

describe("durable dynamic tool schemas", () => {
  it.each(["session", "turn", "step"] as const)(
    "preserves %s input and output validation through context serialization",
    async (scope) => {
      const schema = z.object({ value: z.string().trim().min(1).optional() });
      const { ctx } = await resolve(() => tool(schema, schema), scope);
      const replayed = buildDynamicTools(await deserializeContext(serializeContext(ctx)))[0]!;
      for (const live of [replayed.inputSchema, replayed.outputSchema]) {
        expect(await validate(live, { value: " " })).toHaveProperty("issues");
        expect(await validate(live, { value: "  normalized  " })).toEqual({
          value: { value: "normalized" },
        });
      }
      expect(serializeInputSchema(replayed.inputSchema as ToolSchema)).toEqual(
        serializeInputSchema(schema),
      );
    },
  );

  it.each([
    z.object({ value: z.string().trim().min(1) }),
    z3.object({ value: z3.string().trim().min(1) }),
  ])("preserves Zod transforms after a cold start", async (schema) => {
    const { ctx, resolver } = await resolve(() => tool(schema));
    const replayed = await coldReplay(ctx, resolver);
    expect(await validate(replayed.inputSchema, { value: " " })).toHaveProperty("issues");
    expect(await validate(replayed.inputSchema, { value: " a " })).toEqual({
      value: { value: "a" },
    });
  });

  it("preserves cross-field refinements and asynchronous Standard Schema validation", async () => {
    const schema = z.object({ start: z.number(), end: z.number() }).superRefine((value, ctx) => {
      if (value.start >= value.end)
        ctx.addIssue({ code: "custom", message: "End must follow start" });
    });
    const asyncSchema: ToolSchema = {
      "~standard": {
        version: 1,
        vendor: "custom",
        validate: async (value) =>
          value === "allowed" ? { value: "normalized" } : { issues: [{ message: "Denied" }] },
        jsonSchema: { input: () => ({ type: "string" }), output: () => ({ type: "string" }) },
      },
    };
    const { ctx, resolver } = await resolve(() => tool(schema, asyncSchema));
    const replayed = await coldReplay(ctx, resolver);
    expect(await validate(replayed.inputSchema, { start: 2, end: 1 })).toHaveProperty("issues");
    expect(await validate(replayed.outputSchema, "denied")).toHaveProperty("issues");
    expect(await validate(replayed.outputSchema, "allowed")).toEqual({ value: "normalized" });
  });

  it("rebuilds validation and execution from the same original captures", async () => {
    let limit = 10;
    const { ctx, resolver } = await resolve(() =>
      defineTool({
        description: "Captured limit",
        inputSchema: defineDurableSchema({
          closure: { limit },
          schema: ({ limit }) => z.object({ amount: z.number().refine((value) => value <= limit) }),
        }),
        execute: defineDurableCallback({ closure: { limit }, callback: ({ limit }) => limit }),
      }),
    );
    limit = 100;
    const replayed = await coldReplay(ctx, resolver);
    expect(await validate(replayed.inputSchema, { amount: 50 })).toHaveProperty("issues");
    expect(await validate(replayed.inputSchema, { amount: 5 })).toEqual({ value: { amount: 5 } });
    await expect(replayed.execute!({}, executeOptions)).resolves.toBe(10);
  });

  it("isolates identical JSON shapes across sessions", async () => {
    const makeTool = (required: string) =>
      defineTool({
        description: "Session value",
        inputSchema: defineDurableSchema({
          closure: { required },
          schema: ({ required }) =>
            z.object({ value: z.string().refine((value) => value === required) }),
        }),
        execute: defineDurableCallback({ closure: {}, callback: () => "executed" }),
      });
    const first = await resolve(() => makeTool("first"));
    const second = await resolve(() => makeTool("second"));
    const replayed = await coldReplay(first.ctx, first.resolver);
    expect(await validate(replayed.inputSchema, { value: "second" })).toHaveProperty("issues");
    expect(
      await validate(buildDynamicTools(second.ctx)[0]!.inputSchema, { value: "first" }),
    ).toHaveProperty("issues");
  });

  it("does not evict an active turn schema after 2,048 other resolutions", async () => {
    const { ctx, resolver } = await resolve(() => tool(z.object({ value: z.string() })), "turn");
    // Resolve many entries in one other session: callback storage is bounded by sessions, not individual schemas.
    const other = new ContextContainer();
    other.set(SessionIdKey, `other-schema-session-${++sequence}`);
    other.set(StaticModelReferenceKey, null);
    const otherResolver = {
      ...resolver,
      events: {
        "turn.started": () =>
          Object.fromEntries(
            Array.from({ length: 2_049 }, (_, index) => [`tool_${index}`, tool(z.object({}))]),
          ),
      },
    };
    await dispatchDynamicToolEvent({
      ctx: other,
      resolvers: [otherResolver],
      event: event("turn"),
      messages: [],
    });
    await rebindMissingCompiledDynamicToolCallbacks({
      ctx,
      resolvers: [resolver],
      event: event("turn"),
      messages: [],
    });
    expect(await validate(buildDynamicTools(ctx)[0]!.inputSchema, { value: "ok" })).toEqual({
      value: { value: "ok" },
    });
  });

  it("fails validation closed if a schema factory is removed during recovery", async () => {
    const { ctx, resolver } = await resolve(() => tool(z.object({ value: z.string().min(1) })));
    const replacement = {
      ...resolver,
      events: {
        "session.started": () => ({
          tool: defineTool({
            description: "JSON-only replacement",
            inputSchema: { type: "object" },
            execute: defineDurableCallback({ closure: {}, callback: () => "executed" }),
          }),
        }),
      },
    };
    const replayed = await coldReplay(ctx, replacement);
    await expect(validate(replayed.inputSchema, { value: " " })).rejects.toThrow(
      "cannot replay its inputSchema callback",
    );
  });

  it("rejects an unstamped live schema instead of reducing it to JSON Schema", () => {
    const entry = defineTool({
      description: "Untransformed",
      inputSchema: z.object({ value: z.string().trim() }),
      execute: defineDurableCallback({ closure: {}, callback: () => null }),
    });
    expect(() =>
      validateDurableDynamicToolCallbacks("tool", entry as DynamicToolEntry, owner),
    ).toThrow("defineDurableSchema()");
  });

  it("rejects non-serializable schema captures at resolution", () => {
    const schema = z.object({ value: z.string() });
    const entry = defineTool({
      description: "Invalid capture",
      // Simulate an authored local schema reference captured by the compiler.
      inputSchema: defineDurableSchema({ closure: { schema } as never, schema: () => schema }),
      execute: defineDurableCallback({ closure: {}, callback: () => null }),
    });
    expect(() =>
      validateDurableDynamicToolCallbacks("tool", entry as DynamicToolEntry, owner),
    ).toThrow('"inputSchema" has a non-serializable capture');
  });
});
