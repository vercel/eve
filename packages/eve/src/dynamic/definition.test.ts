import { describe, expect, expectTypeOf, it } from "vitest";

import type { SessionParent } from "#context/keys.js";
import { defineDynamic as defineDynamicConnections } from "#public/connections/index.js";

import { defineAgent, defineDynamic as defineDynamicAgent } from "#public/definitions/agent.js";
import { defineHook } from "#public/definitions/hook.js";
import { defineDynamic as defineDynamicModel } from "#public/definitions/model.js";
import { defineDynamic as defineDynamicTools, defineTool } from "#public/tools/index.js";
import {
  assertDynamicSentinelKeys,
  DYNAMIC_SENTINEL_KIND,
  isDynamicSentinel,
} from "./definition.js";

const tool = defineTool({ description: "Echo.", execute: async () => null, inputSchema: {} });

describe("defineDynamic", () => {
  it("marks a function of the session for the compiler", () => {
    const fn = () => tool;
    const dynamic = defineDynamicTools(fn);

    expect(dynamic).toMatchObject({ evaluate: fn, kind: DYNAMIC_SENTINEL_KIND });
    expect(isDynamicSentinel(dynamic)).toBe(true);
  });

  it("rejects today's events map with the function form in the error", () => {
    expect(() =>
      // @ts-expect-error: defineDynamic takes a function.
      defineDynamicTools({ events: { "turn.started": () => tool } }),
    ).toThrow("takes a function of the session, not an events map");
  });

  it("takes only a function, so packaging configuration belongs on the root agent", () => {
    expect(() =>
      assertDynamicSentinelKeys(
        { ...defineDynamicAgent(() => null), build: {} } as never,
        "subagents/finance/agent.ts:",
      ),
    ).toThrow("Packaging configuration such as build.externalDependencies belongs on the root");
  });

  it("types a model field's context without ctx.model, and every other one with it", () => {
    defineAgent({
      model: defineDynamicAgent(async (ctx) => (ctx.turn === null ? "a/b" : "a/c")),
    });
    defineAgent({
      // @ts-expect-error: the model isn't chosen while the model field's function runs.
      model: defineDynamicAgent(async (ctx) => ctx.model.id),
    });
    defineAgent({
      // @ts-expect-error: the model isn't chosen while the model field's function runs.
      model: defineDynamicModel((ctx) => ctx.model.id),
    });
    defineDynamicTools((ctx) => (ctx.model.id === "a/b" ? tool : null));
  });

  it("types the parent lineage for every kind, including connections and model selection", () => {
    defineDynamicTools((ctx) => {
      expectTypeOf(ctx.session.parent).toEqualTypeOf<SessionParent | undefined>();
      return null;
    });
    defineDynamicConnections((ctx) => {
      expectTypeOf(ctx.session.parent).toEqualTypeOf<SessionParent | undefined>();
      return null;
    });
    defineDynamicModel((ctx) => {
      expectTypeOf(ctx.session.parent).toEqualTypeOf<SessionParent | undefined>();
      return "a/b";
    });
  });
});

describe("defineHook", () => {
  it("takes events handlers and nothing else", () => {
    const hook = defineHook({ events: { "turn.started": () => {} } });
    expect(Object.keys(hook)).toEqual(["events"]);

    expect(() =>
      // @ts-expect-error: a hook acts from an event handler.
      defineHook({ events: {}, select: () => null }),
    ).toThrow("defineHook() takes only events handlers; unknown key(s): select.");
  });
});
