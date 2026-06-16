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
          "message.completed": () => undefined,
          "*": () => undefined,
        },
      },
    });

    const resolved = await resolveHookDefinition(definition, moduleMap, undefined);
    expect(Object.keys(resolved.events).sort()).toEqual(["*", "message.completed"]);
  });

  it("accepts a hook with only `events` declared", async () => {
    const definition = buildDefinition({ slug: "audit" });
    const moduleMap = buildModuleMap(definition.sourceId, {
      default: {
        events: {
          "turn.completed": () => undefined,
          "session.started": () => undefined,
        },
      },
    });

    const resolved = await resolveHookDefinition(definition, moduleMap, undefined);
    expect(Object.keys(resolved.events).sort()).toEqual(["session.started", "turn.completed"]);
  });

  it("accepts a hook with an empty export (no events)", async () => {
    const definition = buildDefinition({ slug: "noop" });
    const moduleMap = buildModuleMap(definition.sourceId, {
      default: {},
    });

    const resolved = await resolveHookDefinition(definition, moduleMap, undefined);
    expect(Object.keys(resolved.events)).toEqual([]);
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
