import { describe, expect, it } from "vitest";

import { buildDynamicTools } from "#context/build-dynamic-tools.js";
import { ContextContainer } from "#context/container.js";
import {
  RuntimeToolContributionsKey,
  StepDynamicToolMetadataKey,
  type DurableDynamicToolMetadata,
} from "#context/keys.js";
import {
  contributeRuntimeTools,
  dispatchRuntimeToolContributors,
  refreshRuntimeToolContributionsForRuntimeRevision,
  type RuntimeToolContributionMap,
  type RuntimeToolContributor,
} from "#context/runtime-tool-contribution.js";
import { defineTool } from "#public/definitions/tool.js";
import type { JsonObject } from "#shared/json.js";
import {
  callDurableDynamicCallback,
  type DurableDynamicCallbackPhase,
  lookupDurableDynamicCallback,
  stampDurableDynamicToolCallbacks,
} from "#shared/durable-dynamic-tool-callbacks.js";

const SESSION_COORDINATE = { event: "session.started" as const };
const TURN_COORDINATE = { event: "turn.started" as const, turnId: "turn-1" };
const STEP_EVENT = {
  data: { modelId: "mock/test", sequence: 0, stepIndex: 0, turnId: "turn-1" },
  type: "step.started" as const,
};

function callbackTool(input: {
  readonly closure?: JsonObject;
  readonly description?: string;
  readonly value: string;
}) {
  const closure = input.closure ?? { value: input.value };
  const entry = defineTool({
    description: input.description ?? input.value,
    inputSchema: { type: "object" },
    execute: () => input.value,
  });
  stampDurableDynamicToolCallbacks(entry, {
    execute: {
      callback: (captured) => captured.value,
      closure,
    },
  });
  return entry;
}

function contribute(input: {
  readonly ctx: ContextContainer;
  readonly ownerId: string;
  readonly prefix?: string;
  readonly tools: RuntimeToolContributionMap | null;
  readonly coordinate?: typeof SESSION_COORDINATE | typeof TURN_COORDINATE;
  readonly revision?: string;
}): void {
  contributeRuntimeTools({
    coordinate: input.coordinate ?? SESSION_COORDINATE,
    ctx: input.ctx,
    ownerId: input.ownerId,
    qualificationPrefix: input.prefix,
    runtimeRevision: input.revision ?? "deployment:one",
    sourceId: `source:${input.ownerId}`,
    tools: input.tools,
  });
}

function names(ctx: ContextContainer): string[] {
  return buildDynamicTools(ctx).map((tool) => tool.name);
}

describe("runtime tool contributions", () => {
  it("captures keyed branded tools through the durable callback path", () => {
    const ctx = new ContextContainer();
    contribute({
      ctx,
      ownerId: "catalog",
      tools: { query: callbackTool({ value: "captured" }) },
    });

    expect(names(ctx)).toEqual(["query"]);
    const metadata = ctx.get(RuntimeToolContributionsKey)!.contributions[0]!.metadata[0]!;
    const callback = lookupDurableDynamicCallback("query", "execute")!;
    expect(callDurableDynamicCallback(callback, metadata.callbacks.execute.closure)).toBe(
      "captured",
    );
  });

  it("captures approval request, response, execution, and output projection together", () => {
    const ctx = new ContextContainer();
    const entry = defineTool({
      description: "guarded",
      inputSchema: { type: "object" },
      approval: {
        request: () => "user-approval",
        response: () => ({ status: "allowed" }),
      },
      execute: () => ({ private: true }),
      toModelOutput: () => ({ type: "text", value: "projected" }),
    });
    stampDurableDynamicToolCallbacks(entry, {
      approvalRequest: { callback: () => "user-approval", closure: {} },
      approvalResponse: {
        callback: () => ({ status: "allowed" }),
        closure: {},
      },
      execute: { callback: () => ({ private: true }), closure: {} },
      toModelOutput: {
        callback: () => ({ type: "text", value: "projected" }),
        closure: {},
      },
    });

    contribute({ ctx, ownerId: "guarded", tools: { guarded: entry } });

    const metadata = ctx.get(RuntimeToolContributionsKey)!.contributions[0]!.metadata[0]!;
    expect(Object.keys(metadata.callbacks).sort()).toEqual([
      "approvalRequest",
      "approvalResponse",
      "execute",
      "toModelOutput",
    ]);
    for (const phase of Object.keys(metadata.callbacks)) {
      expect(
        lookupDurableDynamicCallback("guarded", phase as DurableDynamicCallbackPhase),
      ).toBeTypeOf("function");
    }
  });

  it("qualifies two owners before collision resolution", () => {
    const ctx = new ContextContainer();
    contribute({
      ctx,
      ownerId: "alpha",
      prefix: "alpha",
      tools: { save: callbackTool({ value: "alpha" }) },
    });
    contribute({
      ctx,
      ownerId: "beta",
      prefix: "beta",
      tools: { save: callbackTool({ value: "beta" }) },
    });

    expect(names(ctx)).toEqual(["alpha__save", "beta__save"]);
  });

  it("replaces one owner atomically while retaining other owners", () => {
    const ctx = new ContextContainer();
    contribute({ ctx, ownerId: "alpha", tools: { old: callbackTool({ value: "old" }) } });
    contribute({ ctx, ownerId: "beta", tools: { keep: callbackTool({ value: "keep" }) } });
    contribute({ ctx, ownerId: "alpha", tools: { next: callbackTool({ value: "next" }) } });

    expect(names(ctx)).toEqual(["keep", "next"]);
    expect(
      ctx.get(RuntimeToolContributionsKey)!.contributions.map((entry) => entry.ownerId),
    ).toEqual(["beta", "alpha"]);
  });

  it("removes only the selected owner for null and empty maps", () => {
    const ctx = new ContextContainer();
    contribute({ ctx, ownerId: "alpha", tools: { a: callbackTool({ value: "a" }) } });
    contribute({ ctx, ownerId: "beta", tools: { b: callbackTool({ value: "b" }) } });

    contribute({ ctx, ownerId: "alpha", tools: null });
    expect(names(ctx)).toEqual(["b"]);
    contribute({ ctx, ownerId: "beta", tools: {} });
    expect(names(ctx)).toEqual([]);
  });

  it("keeps the previous owner set when the replacement is invalid", () => {
    const ctx = new ContextContainer();
    contribute({ ctx, ownerId: "alpha", tools: { old: callbackTool({ value: "old" }) } });
    const before = ctx.get(RuntimeToolContributionsKey);

    expect(() =>
      contribute({
        ctx,
        ownerId: "alpha",
        tools: {
          valid: callbackTool({ value: "valid" }),
          invalid: { description: "not branded" } as never,
        },
      }),
    ).toThrow(/without defineTool/);
    expect(ctx.get(RuntimeToolContributionsKey)).toBe(before);
    expect(names(ctx)).toEqual(["old"]);
  });

  it("rejects lone tools, invalid names, and double qualification", () => {
    const ctx = new ContextContainer();
    const lone = callbackTool({ value: "lone" });
    expect(() =>
      Reflect.apply(contributeRuntimeTools, undefined, [
        {
          coordinate: SESSION_COORDINATE,
          ctx,
          ownerId: "alpha",
          runtimeRevision: "deployment:one",
          sourceId: "source:alpha",
          tools: lone,
        },
      ]),
    ).toThrow(/keyed map/);
    expect(() => contribute({ ctx, ownerId: "alpha", tools: { "bad name": lone } })).toThrow(
      /invalid tool name/,
    );
    expect(() =>
      contribute({ ctx, ownerId: "alpha", prefix: "alpha", tools: { alpha__save: lone } }),
    ).toThrow(/already qualified/);
  });

  it("rejects same-scope collisions with authored dynamic and runtime owners", () => {
    const ctx = new ContextContainer();
    const authored = {
      callbacks: { execute: { closure: {} } },
      description: "authored",
      entryKey: "shared",
      inputSchema: {},
      name: "shared",
      resolverSlug: "authored",
    } satisfies DurableDynamicToolMetadata;
    ctx.set(StepDynamicToolMetadataKey, [authored]);

    expect(() =>
      contributeRuntimeTools({
        coordinate: { event: "step.started", stepIndex: 0, turnId: "turn-1" },
        ctx,
        ownerId: "runtime",
        runtimeRevision: "deployment:one",
        sourceId: "source:runtime",
        tools: { shared: callbackTool({ value: "runtime" }) },
      }),
    ).toThrow(/collides with dynamic resolver/);

    ctx.set(StepDynamicToolMetadataKey, []);
    contributeRuntimeTools({
      coordinate: { event: "step.started", stepIndex: 0, turnId: "turn-1" },
      ctx,
      ownerId: "one",
      runtimeRevision: "deployment:one",
      sourceId: "source:one",
      tools: { shared: callbackTool({ value: "one" }) },
    });
    expect(() =>
      contributeRuntimeTools({
        coordinate: { event: "step.started", stepIndex: 0, turnId: "turn-1" },
        ctx,
        ownerId: "two",
        runtimeRevision: "deployment:one",
        sourceId: "source:two",
        tools: { shared: callbackTool({ value: "two" }) },
      }),
    ).toThrow(/collides with runtime contributor/);
  });

  it("preserves dynamic scope precedence across contribution scopes", () => {
    const ctx = new ContextContainer();
    contribute({
      ctx,
      ownerId: "session-owner",
      tools: { shared: callbackTool({ description: "session", value: "session" }) },
    });
    contribute({
      coordinate: TURN_COORDINATE,
      ctx,
      ownerId: "turn-owner",
      tools: { shared: callbackTool({ description: "turn", value: "turn" }) },
    });

    expect(buildDynamicTools(ctx).map((tool) => tool.description)).toEqual(["turn", "session"]);
  });

  it("dispatches subscribed contributors and clears expired step owners", async () => {
    const ctx = new ContextContainer();
    let calls = 0;
    const contributor: RuntimeToolContributor = {
      eventNames: ["step.started"],
      ownerId: "step-owner",
      resolve: () => ({ current: callbackTool({ value: String(++calls) }) }),
      sourceId: "source:step-owner",
    };

    await dispatchRuntimeToolContributors({
      contributors: [contributor],
      ctx,
      event: STEP_EVENT,
      messages: [],
      runtimeRevision: "deployment:one",
    });
    expect(names(ctx)).toEqual(["current"]);

    await dispatchRuntimeToolContributors({
      contributors: [],
      ctx,
      event: { ...STEP_EVENT, data: { ...STEP_EVENT.data, stepIndex: 1 } },
      messages: [],
      runtimeRevision: "deployment:one",
    });
    expect(names(ctx)).toEqual([]);
  });

  it("refreshes registered sources and removes contributors absent from a new revision", async () => {
    const ctx = new ContextContainer();
    contribute({
      ctx,
      ownerId: "present",
      revision: "deployment:old",
      tools: { old: callbackTool({ value: "old" }) },
    });
    contribute({
      ctx,
      ownerId: "removed",
      revision: "deployment:old",
      tools: { removed: callbackTool({ value: "removed" }) },
    });
    const present: RuntimeToolContributor = {
      eventNames: ["session.started"],
      ownerId: "present",
      resolve: () => ({ next: callbackTool({ value: "next" }) }),
      sourceId: "source:present",
    };

    await refreshRuntimeToolContributionsForRuntimeRevision({
      contributors: [present],
      ctx,
      runtimeRevision: "deployment:new",
    });

    expect(names(ctx)).toEqual(["next"]);
    expect(ctx.get(RuntimeToolContributionsKey)!.contributions).toMatchObject([
      { ownerId: "present", runtimeRevision: "deployment:new" },
    ]);
  });

  it("rehydrates a packaged factory without serializing its live service", async () => {
    class Service {
      read(key: string): string {
        return `live:${key}`;
      }
    }
    const services = new Map([["catalog", new Service()]]);
    const contributor: RuntimeToolContributor = {
      eventNames: ["session.started"],
      ownerId: "packaged",
      resolve: () => {
        const entry = callbackTool({ closure: { key: "catalog" }, value: "unused" });
        stampDurableDynamicToolCallbacks(entry, {
          execute: {
            callback: (closure) => services.get(String(closure.key))!.read(String(closure.key)),
            closure: { key: "catalog" },
          },
        });
        return { packaged: entry };
      },
      sourceId: "source:packaged",
    };
    const tools = await contributor.resolve({
      coordinate: SESSION_COORDINATE,
      ctx: new ContextContainer(),
      messages: [],
    });
    const ctx = new ContextContainer();
    contributeRuntimeTools({
      coordinate: SESSION_COORDINATE,
      ctx,
      ownerId: contributor.ownerId,
      runtimeRevision: "deployment:one",
      sourceId: contributor.sourceId,
      tools,
    });

    const metadata = ctx.get(RuntimeToolContributionsKey)!.contributions[0]!.metadata[0]!;
    expect(metadata.callbacks.execute.closure).toEqual({ key: "catalog" });
    const callback = lookupDurableDynamicCallback("packaged", "execute")!;
    expect(callDurableDynamicCallback(callback, metadata.callbacks.execute.closure)).toBe(
      "live:catalog",
    );
  });

  it("fails safely for unknown durable state versions", () => {
    const ctx = new ContextContainer();
    ctx.set(RuntimeToolContributionsKey, { contributions: [], version: 2 } as never);
    expect(() => buildDynamicTools(ctx)).toThrow(/unsupported or malformed version/);
  });
});
