import { describe, expect, it } from "vitest";

import type { CompiledHookDefinition } from "../compiler/manifest.js";
import type { CompiledModuleMap } from "../compiler/module-map.js";
import { ROOT_COMPILED_AGENT_NODE_ID } from "../compiler/manifest.js";
import { resolveHookDefinition } from "./resolve-hook.js";

/**
 * Builds a minimal {@link CompiledModuleMap} that exposes one authored
 * module under one source id at the root node.
 */
function buildModuleMap(sourceId: string, moduleNamespace: unknown): CompiledModuleMap {
  return {
    nodes: {
      [ROOT_COMPILED_AGENT_NODE_ID]: {
        modules: {
          [sourceId]: moduleNamespace,
        },
      },
    },
  } as CompiledModuleMap;
}

function buildDefinition(input: { readonly slug: string }): CompiledHookDefinition {
  return {
    eventNames: [],
    exportName: undefined,
    logicalPath: `agent/hooks/${input.slug}.ts`,
    slug: input.slug,
    sourceId: `agent/hooks/${input.slug}.ts`,
    sourceKind: "module",
  };
}

describe("resolveHookDefinition", () => {
  it("buckets stream-event keys and the wildcard from the nested shape", async () => {
    const definition = buildDefinition({ slug: "audit" });
    const moduleMap = buildModuleMap(definition.sourceId, {
      default: {
        events: {
          "content.completed": () => undefined,
          "*": () => undefined,
        },
      },
    });

    const resolved = await resolveHookDefinition(definition, moduleMap, undefined);
    expect(Object.keys(resolved.events).sort()).toEqual(["*", "content.completed"]);
  });

  it("accepts a hook with only `events` declared", async () => {
    const definition = buildDefinition({ slug: "audit" });
    const moduleMap = buildModuleMap(definition.sourceId, {
      default: {
        events: {
          "turn.settled": () => undefined,
          "session.started": () => undefined,
        },
      },
    });

    const resolved = await resolveHookDefinition(definition, moduleMap, undefined);
    expect(Object.keys(resolved.events).sort()).toEqual(["session.started", "turn.settled"]);
  });

  it("refuses a v26 key and names its replacement", async () => {
    const definition = buildDefinition({ slug: "audit" });
    const moduleMap = buildModuleMap(definition.sourceId, {
      default: { events: { "turn.completed": () => undefined } },
    });

    await expect(resolveHookDefinition(definition, moduleMap, undefined)).rejects.toThrow(
      "Key on `turn.settled`",
    );
  });

  it("rejects a hook that takes neither form", async () => {
    const definition = buildDefinition({ slug: "noop" });
    const moduleMap = buildModuleMap(definition.sourceId, {
      default: {},
    });

    await expect(resolveHookDefinition(definition, moduleMap, undefined)).rejects.toThrow(
      "requires events, or select and resolve",
    );
  });

  it("rejects a hook with both events and select and resolve", async () => {
    const definition = buildDefinition({ slug: "both" });
    const moduleMap = buildModuleMap(definition.sourceId, {
      default: { events: {}, resolve: () => null, select: () => null },
    });

    await expect(resolveHookDefinition(definition, moduleMap, undefined)).rejects.toThrow(
      "either events or select and resolve, not both",
    );
  });

  it("rejects a hook resolve without select", async () => {
    const definition = buildDefinition({ slug: "unselected" });
    const moduleMap = buildModuleMap(definition.sourceId, {
      default: { resolve: () => null },
    });

    await expect(resolveHookDefinition(definition, moduleMap, undefined)).rejects.toThrow(
      "Return null from select to resolve once per session",
    );
  });

  it("rejects a non-function event handler with a typed error", async () => {
    const definition = buildDefinition({ slug: "broken" });
    const moduleMap = buildModuleMap(definition.sourceId, {
      default: {
        events: {
          "session.started": 42,
        },
      },
    });

    await expect(resolveHookDefinition(definition, moduleMap, undefined)).rejects.toThrow(
      /events\.session\.started/,
    );
  });
});
