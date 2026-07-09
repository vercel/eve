import { describe, expect, it } from "vitest";

import {
  applyOverrideDisables,
  type CompiledExtensionContributions,
  mergeContributions,
} from "#compiler/normalize-extension.js";

// mergeContributions only reads each named contribution's identifier for dedup,
// so minimal partial fixtures suffice.
function contributions(
  overrides: Partial<CompiledExtensionContributions>,
): CompiledExtensionContributions {
  return {
    tools: [],
    dynamicTools: [],
    hooks: [],
    skills: [],
    dynamicSkills: [],
    dynamicInstructions: [],
    connections: [],
    instructionFragments: [],
    ...overrides,
  };
}

describe("mergeContributions", () => {
  it("keeps the primary (consumer override) entry when a named contribution collides", () => {
    const primary = contributions({
      tools: [{ name: "crm__search", logicalPath: "override" }] as never,
      connections: [{ connectionName: "crm__api", logicalPath: "override" }] as never,
      skills: [{ name: "crm__lookup", logicalPath: "override" }] as never,
      dynamicTools: [{ slug: "crm__dynamic", logicalPath: "override" }] as never,
    });
    const secondary = contributions({
      tools: [
        { name: "crm__search", logicalPath: "extension" },
        { name: "crm__list", logicalPath: "extension" },
      ] as never,
      connections: [{ connectionName: "crm__api", logicalPath: "extension" }] as never,
      skills: [{ name: "crm__lookup", logicalPath: "extension" }] as never,
      dynamicTools: [{ slug: "crm__dynamic", logicalPath: "extension" }] as never,
    });

    const merged = mergeContributions(primary, secondary);

    expect(merged.tools).toEqual([
      { name: "crm__search", logicalPath: "override" },
      { name: "crm__list", logicalPath: "extension" },
    ]);
    expect(merged.connections).toEqual([{ connectionName: "crm__api", logicalPath: "override" }]);
    expect(merged.skills).toEqual([{ name: "crm__lookup", logicalPath: "override" }]);
    expect(merged.dynamicTools).toEqual([{ slug: "crm__dynamic", logicalPath: "override" }]);
  });

  it("concatenates unnamed contributions from both sets", () => {
    const primary = contributions({
      hooks: [{ slug: "crm__before" }] as never,
      instructionFragments: ["override fragment"],
    });
    const secondary = contributions({
      hooks: [{ slug: "crm__after" }] as never,
      instructionFragments: ["extension fragment"],
    });

    const merged = mergeContributions(primary, secondary);

    expect(merged.hooks).toEqual([{ slug: "crm__before" }, { slug: "crm__after" }]);
    expect(merged.instructionFragments).toEqual(["override fragment", "extension fragment"]);
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
