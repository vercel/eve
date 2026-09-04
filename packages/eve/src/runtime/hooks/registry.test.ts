import { describe, expect, it } from "vitest";

import type { ResolvedHookDefinition } from "../types.js";
import { createEmptyHookRegistry, createRuntimeHookRegistry } from "./registry.js";

describe("createRuntimeHookRegistry", () => {
  it("splits settlement and stream-event hooks", () => {
    const beforeResponseRelease = async () => undefined;
    const typed = async () => {};
    const wildcard = async () => {};

    const registry = createRuntimeHookRegistry([
      makeHook({
        beforeResponseRelease,
        slug: "audit",
        events: { "message.completed": typed, "*": wildcard },
      }),
    ]);

    expect(registry.beforeResponseRelease).toEqual([
      { handler: beforeResponseRelease, slug: "audit" },
    ]);
    expect(
      (registry.streamEventsByType.get("message.completed") ?? []).map((e) => e.eventType),
    ).toEqual(["message.completed"]);
    expect(registry.streamEventsWildcard.map((e) => e.eventType)).toEqual(["*"]);
  });
});

describe("createEmptyHookRegistry", () => {
  it("returns flat empty buckets", () => {
    const registry = createEmptyHookRegistry();
    expect(registry.beforeResponseRelease).toEqual([]);
    expect(registry.streamEventsByType.size).toBe(0);
    expect(registry.streamEventsWildcard).toEqual([]);
  });
});

function makeHook(partial: {
  readonly beforeResponseRelease?: ResolvedHookDefinition["beforeResponseRelease"];
  readonly slug: string;
  readonly events?: ResolvedHookDefinition["events"];
}): ResolvedHookDefinition {
  return {
    beforeResponseRelease: partial.beforeResponseRelease,
    events: partial.events ?? {},
    exportName: undefined,
    logicalPath: `hooks/${partial.slug}.ts`,
    slug: partial.slug,
    sourceId: `hooks/${partial.slug}.ts`,
    sourceKind: "module",
  };
}
