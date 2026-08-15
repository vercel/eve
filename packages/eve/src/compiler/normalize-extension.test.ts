import { describe, expect, it } from "vitest";

import {
  applyOverrideDisables,
  composeExtensionSubagentSources,
  type CompiledExtensionContributions,
  mergeContributions,
} from "#compiler/normalize-extension.js";
import {
  createAgentSourceManifest,
  createLocalSubagentSourceRef,
  createModuleSourceRef,
} from "#discover/manifest.js";

// mergeContributions only reads each named contribution's identifier for dedup,
// so minimal partial fixtures suffice.
function contributions(
  overrides: Partial<CompiledExtensionContributions>,
): CompiledExtensionContributions {
  return {
    channels: [],
    tools: [],
    dynamicTools: [],
    hooks: [],
    skills: [],
    dynamicSkills: [],
    dynamicInstructions: [],
    connections: [],
    instructions: [],
    schedules: [],
    ...overrides,
  };
}

describe("mergeContributions", () => {
  it("keeps the primary (consumer override) entry when a named contribution collides", () => {
    const primary = contributions({
      channels: [
        { name: "crm__webhook", logicalPath: "override", method: "GET" },
        { name: "crm__webhook", logicalPath: "override", method: "POST" },
      ] as never,
      tools: [{ name: "crm__search", logicalPath: "override" }] as never,
      connections: [{ connectionName: "crm__api", logicalPath: "override" }] as never,
      skills: [{ name: "crm__lookup", logicalPath: "override" }] as never,
      dynamicTools: [{ slug: "crm__dynamic", logicalPath: "override" }] as never,
      schedules: [{ name: "crm__sweep", logicalPath: "override" }] as never,
    });
    const secondary = contributions({
      channels: [
        { name: "crm__webhook", logicalPath: "extension", method: "POST" },
        { name: "crm__status", logicalPath: "extension", method: "GET" },
      ] as never,
      tools: [
        { name: "crm__search", logicalPath: "extension" },
        { name: "crm__list", logicalPath: "extension" },
      ] as never,
      connections: [{ connectionName: "crm__api", logicalPath: "extension" }] as never,
      skills: [{ name: "crm__lookup", logicalPath: "extension" }] as never,
      dynamicTools: [{ slug: "crm__dynamic", logicalPath: "extension" }] as never,
      schedules: [
        { name: "crm__sweep", logicalPath: "extension" },
        { name: "crm__digest", logicalPath: "extension" },
      ] as never,
    });

    const merged = mergeContributions(primary, secondary);

    expect(merged.channels).toEqual([
      { name: "crm__webhook", logicalPath: "override", method: "GET" },
      { name: "crm__webhook", logicalPath: "override", method: "POST" },
      { name: "crm__status", logicalPath: "extension", method: "GET" },
    ]);
    expect(merged.tools).toEqual([
      { name: "crm__search", logicalPath: "override" },
      { name: "crm__list", logicalPath: "extension" },
    ]);
    expect(merged.connections).toEqual([{ connectionName: "crm__api", logicalPath: "override" }]);
    expect(merged.skills).toEqual([{ name: "crm__lookup", logicalPath: "override" }]);
    expect(merged.dynamicTools).toEqual([{ slug: "crm__dynamic", logicalPath: "override" }]);
    expect(merged.schedules).toEqual([
      { name: "crm__sweep", logicalPath: "override" },
      { name: "crm__digest", logicalPath: "extension" },
    ]);
  });

  it("concatenates unnamed contributions from both sets", () => {
    const primary = contributions({
      hooks: [{ slug: "crm__before" }] as never,
      instructions: [{ content: "override", role: "system" }] as never,
    });
    const secondary = contributions({
      hooks: [{ slug: "crm__after" }] as never,
      instructions: [{ content: "extension", role: "user" }] as never,
    });

    const merged = mergeContributions(primary, secondary);

    expect(merged.hooks).toEqual([{ slug: "crm__before" }, { slug: "crm__after" }]);
    expect(merged.instructions).toEqual([
      { content: "override", role: "system" },
      { content: "extension", role: "user" },
    ]);
  });
});

describe("composeExtensionSubagentSources", () => {
  it("namespaces extension subagents and lets a directory override win", () => {
    const extensionRoot = "/packages/crm/dist/extension";
    const overrideRoot = "/app/agent/extensions/crm";
    const createSubagent = (root: string, subagentId: string) => {
      const agentRoot = `${root}/subagents/${subagentId}`;
      return createLocalSubagentSourceRef({
        entryPath: agentRoot,
        logicalPath: `subagents/${subagentId}`,
        manifest: createAgentSourceManifest({
          agentId: subagentId,
          agentRoot,
          appRoot: "/app",
          configModule: createModuleSourceRef({ logicalPath: "agent.ts" }),
          tools: [createModuleSourceRef({ logicalPath: "tools/search.ts" })],
        }),
        rootPath: agentRoot,
        subagentId,
      });
    };
    const extensionManifest = createAgentSourceManifest({
      agentRoot: extensionRoot,
      appRoot: "/packages/crm",
      subagents: [
        createSubagent(extensionRoot, "reviewer"),
        createSubagent(extensionRoot, "analyst"),
      ],
    });
    const overrideManifest = createAgentSourceManifest({
      agentRoot: overrideRoot,
      appRoot: "/app",
      subagents: [createSubagent(overrideRoot, "reviewer")],
    });

    const result = composeExtensionSubagentSources({
      consumerAgentRoot: "/app/agent",
      mount: {
        namespace: "crm",
        specifier: "@acme/crm",
        packageName: "@acme/crm",
        packageRoot: "/packages/crm",
        sourceRoot: extensionRoot,
        manifest: extensionManifest,
        overrides: overrideManifest,
      },
    });

    expect(result.map((source) => [source.subagentId, source.sourceId])).toEqual([
      ["crm__reviewer", "ext-override:crm:subagents/reviewer"],
      ["crm__analyst", "ext:crm:subagents/analyst"],
    ]);
    expect(result[1]?.manifest.tools[0]?.sourceId).toBe(
      "ext:crm:subagents/analyst/tools/search.ts",
    );
  });
});

describe("applyOverrideDisables", () => {
  it("removes the disabled static extension tool while keeping the rest", () => {
    const merged = contributions({
      tools: [
        { name: "crm__search", logicalPath: "extension" },
        { name: "crm__list", logicalPath: "extension" },
      ] as never,
    });

    const result = applyOverrideDisables({
      merged,
      disables: [{ name: "crm__search", logicalPath: "tools/search.ts" }],
      extensionToolNames: new Set(["crm__search", "crm__list"]),
      extensionDynamicToolSlugs: new Set(),
      namespace: "crm",
    });

    expect(result.tools).toEqual([{ name: "crm__list", logicalPath: "extension" }]);
  });

  it("removes a disabled dynamic resolver slot by slug", () => {
    const merged = contributions({
      tools: [{ name: "crm__list", logicalPath: "extension" }] as never,
      dynamicTools: [{ slug: "crm__search", logicalPath: "extension" }] as never,
    });

    const result = applyOverrideDisables({
      merged,
      disables: [{ name: "crm__search", logicalPath: "tools/search.ts" }],
      extensionToolNames: new Set(["crm__list"]),
      extensionDynamicToolSlugs: new Set(["crm__search"]),
      namespace: "crm",
    });

    expect(result.dynamicTools).toEqual([]);
    expect(result.tools).toEqual([{ name: "crm__list", logicalPath: "extension" }]);
  });

  it("throws, listing static and dynamic slots, when the disable targets neither", () => {
    expect(() =>
      applyOverrideDisables({
        merged: contributions({
          tools: [{ name: "crm__list", logicalPath: "extension" }] as never,
          dynamicTools: [{ slug: "crm__lookup", logicalPath: "extension" }] as never,
        }),
        disables: [{ name: "crm__search", logicalPath: "tools/search.ts" }],
        extensionToolNames: new Set(["crm__list"]),
        extensionDynamicToolSlugs: new Set(["crm__lookup"]),
        namespace: "crm",
      }),
    ).toThrow(/no tool named "search"[\s\S]*It contributes: list, lookup/);
  });

  it("returns the merged set unchanged when nothing is disabled", () => {
    const merged = contributions({ tools: [{ name: "crm__list" }] as never });

    expect(
      applyOverrideDisables({
        merged,
        disables: [],
        extensionToolNames: new Set(["crm__list"]),
        extensionDynamicToolSlugs: new Set(),
        namespace: "crm",
      }),
    ).toBe(merged);
  });
});
