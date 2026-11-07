import { describe, expect, it } from "vitest";

import type { CompiledDefinition } from "../compiler/manifest.js";
import type { CompiledModuleMap } from "../compiler/module-map-schema.js";
import { ROOT_COMPILED_AGENT_NODE_ID } from "../compiler/manifest.js";
import { resolveDefinition } from "./resolve-definition.js";

async function resolveHookDefinition(definition: CompiledDefinition, moduleMap: CompiledModuleMap) {
  const resolved = await resolveDefinition(definition, {
    moduleMap,
    nodeId: undefined,
    toolFiles: new Set(),
  });
  if (resolved.kind !== "hook") throw new Error("Expected a hook.");
  return resolved;
}

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

function buildDefinition(input: { readonly slug: string }): CompiledDefinition {
  return {
    kind: "hook",
    logicalPath: `agent/hooks/${input.slug}.ts`,
    slug: input.slug,
    sourceId: `agent/hooks/${input.slug}.ts`,
    sourceKind: "module",
  };
}

describe("resolveDefinition for a hook", () => {
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

    const resolved = await resolveHookDefinition(definition, moduleMap);
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

    const resolved = await resolveHookDefinition(definition, moduleMap);
    expect(Object.keys(resolved.events).sort()).toEqual(["session.started", "turn.settled"]);
  });

  it("refuses a v26 key and names its replacement", async () => {
    const definition = buildDefinition({ slug: "audit" });
    const moduleMap = buildModuleMap(definition.sourceId, {
      default: { events: { "turn.completed": () => undefined } },
    });

    await expect(resolveHookDefinition(definition, moduleMap)).rejects.toThrow(
      "Key on `turn.settled`",
    );
  });

  it("rejects a hook without events", async () => {
    const definition = buildDefinition({ slug: "noop" });
    const moduleMap = buildModuleMap(definition.sourceId, {
      default: {},
    });

    await expect(resolveHookDefinition(definition, moduleMap)).rejects.toThrow(
      "requires events: an object of handlers keyed by event type",
    );
  });

  it("rejects keys beside events", async () => {
    const definition = buildDefinition({ slug: "both" });
    const moduleMap = buildModuleMap(definition.sourceId, {
      default: { events: {}, run: () => null, select: () => null },
    });

    await expect(resolveHookDefinition(definition, moduleMap)).rejects.toThrow(
      "takes only events handlers; unknown key(s): run, select.",
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

    await expect(resolveHookDefinition(definition, moduleMap)).rejects.toThrow(
      /events\.session\.started/,
    );
  });
});
