import { describe, expect, it } from "vitest";

import { defineDynamic as defineDynamicAgent } from "#public/definitions/agent.js";
import { cancel, defineHook, type HookDefinition } from "#public/definitions/hook.js";
import { defineDynamic as defineDynamicInstructions } from "#public/definitions/instructions.js";
import { defineDynamic as defineDynamicSkills } from "#public/definitions/skill.js";
import { defineDynamic as defineDynamicTools, defineTool } from "#public/tools/index.js";
import { assertReactionForm, DYNAMIC_SENTINEL_KIND, once } from "./definition.js";

declare const flag: boolean;
const tool = defineTool({ description: "Echo.", execute: async () => null, inputSchema: {} });

describe("defineDynamic and defineHook", () => {
  it("compile to the same reaction form", () => {
    const dynamic = defineDynamicTools({ select: () => null, render: () => tool });
    const hook = defineHook({ select: () => null, run: () => cancel() });
    const awaited = defineHook({ select: () => null, run: async () => cancel() });
    const events = defineHook({ events: { "turn.started": () => null } });

    for (const definition of [dynamic, hook, awaited, events]) {
      expect(definition).toMatchObject({ kind: DYNAMIC_SENTINEL_KIND });
    }
  });

  it("require select beside record or render", () => {
    expect(() =>
      // @ts-expect-error: select is required; select: once resolves once.
      defineDynamicTools({ render: () => tool }),
    ).toThrow("Use select: once to resolve once per session");
    expect(() =>
      // @ts-expect-error: a hook's run needs a select too.
      defineHook({ run: () => null }),
    ).toThrow("requires a select function beside run");
  });

  it("give hooks run, and values record and render", () => {
    expect(() =>
      // @ts-expect-error: a hook has nothing to render.
      defineHook({ select: () => null, render: () => cancel() }),
    ).toThrow("a hook acts rather than holds a value");
    expect(() =>
      // @ts-expect-error: run is a hook's.
      defineDynamicTools({ select: () => null, run: () => null }),
    ).toThrow("run is a hook's");
  });

  it("require render for tools and connections", () => {
    expect(() =>
      assertReactionForm({ record: () => null, select: once }, "tools/x.ts", {
        render: "required",
      }),
    ).toThrow("needs render: what record returns is kept, so it must be JSON");
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
      // @ts-expect-error: events, or select, never both.
      defineHook({ events: {}, run: () => null, select: () => null }),
    ).toThrow("not both");
  });

  it("reject events outside hooks", () => {
    expect(() => assertReactionForm({ events: {} }, "defineDynamic()")).toThrow(
      "takes select with record or render, not events",
    );
  });

  it("make a missing return a type error in capability folders", () => {
    // Each would quietly contribute nothing at runtime; the types reject them instead.
    defineDynamicTools({
      select: () => null,
      // @ts-expect-error: a branch without a return.
      render: () => {
        if (flag) return tool;
      },
    });
    // @ts-expect-error: what record returns is kept as JSON, so tools are rendered.
    defineDynamicTools({ select: () => null, record: () => tool });
    // @ts-expect-error: no return at all.
    defineDynamicSkills({ select: () => null, render: () => {} });
    // @ts-expect-error: no return at all.
    defineDynamicInstructions({ select: () => null, render: () => {} });
    // @ts-expect-error: no return at all.
    defineDynamicAgent({ select: () => null, render: () => {} });
  });
});
