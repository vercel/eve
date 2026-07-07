import { describe, expect, it } from "vitest";

import {
  type CompiledExtensionContributions,
  mergeContributions,
} from "#compiler/normalize-extension.js";

/**
 * Builds a {@link CompiledExtensionContributions} set from partial entries.
 * `mergeContributions` only reads the model-facing identifier of each named
 * contribution for dedup and otherwise preserves entries verbatim, so minimal
 * fixtures are enough to exercise the precedence rule.
 */
function contributions(
  overrides: Partial<CompiledExtensionContributions>,
): CompiledExtensionContributions {
  return {
    tools: [],
    dynamicTools: [],
    hooks: [],
    schedules: [],
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
      schedules: [{ name: "crm__sweep", logicalPath: "override" }] as never,
      dynamicTools: [{ slug: "crm__dynamic", logicalPath: "override" }] as never,
    });
    const secondary = contributions({
      tools: [
        { name: "crm__search", logicalPath: "extension" },
        { name: "crm__list", logicalPath: "extension" },
      ] as never,
      connections: [{ connectionName: "crm__api", logicalPath: "extension" }] as never,
      skills: [{ name: "crm__lookup", logicalPath: "extension" }] as never,
      schedules: [{ name: "crm__sweep", logicalPath: "extension" }] as never,
      dynamicTools: [{ slug: "crm__dynamic", logicalPath: "extension" }] as never,
    });

    const merged = mergeContributions(primary, secondary);

    expect(merged.tools).toEqual([
      { name: "crm__search", logicalPath: "override" },
      { name: "crm__list", logicalPath: "extension" },
    ]);
    expect(merged.connections).toEqual([{ connectionName: "crm__api", logicalPath: "override" }]);
    expect(merged.skills).toEqual([{ name: "crm__lookup", logicalPath: "override" }]);
    expect(merged.schedules).toEqual([{ name: "crm__sweep", logicalPath: "override" }]);
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
