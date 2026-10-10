import { describe, expect, it } from "vitest";

import { defineDynamic as defineDynamicAgent } from "#public/definitions/agent.js";
import { cancel, defineHook, type HookDefinition } from "#public/definitions/hook.js";
import { defineDynamic as defineDynamicInstructions } from "#public/definitions/instructions.js";
import { defineDynamic as defineDynamicSkills } from "#public/definitions/skill.js";
import { defineDynamic as defineDynamicTools, defineTool } from "#public/tools/index.js";
import { assertResolverForm, DYNAMIC_SENTINEL_KIND } from "./definition.js";

declare const flag: boolean;
const tool = defineTool({ description: "Echo.", execute: async () => null, inputSchema: {} });

describe("defineDynamic and defineHook", () => {
  it("compile to the same resolver form", () => {
    const dynamic = defineDynamicTools({ select: () => null, resolve: () => tool });
    const hook = defineHook({ select: () => null, resolve: () => cancel() });
    const events = defineHook({ events: { "turn.started": () => null } });

    for (const definition of [dynamic, hook, events]) {
      expect(definition).toMatchObject({ kind: DYNAMIC_SENTINEL_KIND });
    }
  });

  it("require select beside resolve", () => {
    expect(() =>
      // @ts-expect-error: select is required; return null from it to resolve once.
      defineDynamicTools({ resolve: () => tool }),
    ).toThrow("Return null from select to resolve once per session");
    expect(() =>
      // @ts-expect-error: a hook's resolve needs a select too.
      defineHook({ resolve: () => null }),
    ).toThrow("Return null from select to resolve once per session");
  });

  it("type event handlers from their keys, with or without a declared type", () => {
    const declared: HookDefinition = defineHook({
      events: {
        "call.settled"(event, ctx) {
          void event.data.callId;
          void ctx.view;
        },
      },
    });
    const inferred = defineHook({ events: { "*": (event) => void event.type } });
    expect([declared, inferred]).toHaveLength(2);
    // @ts-expect-error: not a hook event.
    defineHook({ events: { "step.started": () => null } });
  });

  it("reject a hook with both forms", () => {
    expect(() =>
      // @ts-expect-error: events, or select and resolve, never both.
      defineHook({ events: {}, resolve: () => null, select: () => null }),
    ).toThrow("not both");
  });

  it("reject events outside hooks", () => {
    expect(() =>
      assertResolverForm({ events: {} }, "defineDynamic()", { events: false }),
    ).toThrow("takes select and resolve, not events");
  });

  it("make a missing return a type error in capability folders", () => {
    // Each would quietly contribute nothing at runtime; the types reject them instead.
    defineDynamicTools({
      select: () => null,
      // @ts-expect-error: a branch without a return.
      resolve: () => {
        if (flag) return tool;
      },
    });
    defineDynamicTools({
      select: () => null,
      // @ts-expect-error: an async branch without a return.
      resolve: async () => {
        if (flag) return tool;
      },
    });
    // @ts-expect-error: no return at all.
    defineDynamicSkills({ select: () => null, resolve: () => {} });
    // @ts-expect-error: no return at all.
    defineDynamicInstructions({ select: () => null, resolve: () => {} });
    // @ts-expect-error: no return at all.
    defineDynamicAgent({ select: () => null, resolve: () => {} });
  });
});
