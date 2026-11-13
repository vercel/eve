import { describe, expect, it } from "vitest";

import type { CompiledDefinition } from "#compiler/manifest.js";
import { deriveHarnessSlug, orderHarnessDefinitions } from "#compiler/normalize-definitions.js";

function definition(
  kind: CompiledDefinition["kind"],
  logicalPath: string,
  extensionNamespace?: string,
): CompiledDefinition {
  return {
    ...(extensionNamespace !== undefined && { extensionNamespace }),
    kind,
    logicalPath,
    slug: logicalPath,
    sourceId: logicalPath,
    sourceKind: "module",
  };
}

describe("deriveHarnessSlug", () => {
  it.each([
    ["harness.ts", "harness"],
    ["harness.mjs", "harness"],
    ["harness/crm.ts", "crm"],
  ])("names %s %s", (logicalPath, slug) => {
    expect(deriveHarnessSlug(logicalPath)).toBe(slug);
  });
});

describe("orderHarnessDefinitions", () => {
  it("puts the agent's own harness layers ahead of extensions', leaving other kinds in place", () => {
    const definitions = [
      definition("harness", "harness/alpha.ts", "alpha"),
      definition("hook", "hooks/audit.ts"),
      definition("harness", "harness/beta.ts", "beta"),
      definition("memory", "memory.ts"),
      definition("harness", "harness.ts"),
    ];

    expect(orderHarnessDefinitions(definitions).map((entry) => entry.logicalPath)).toEqual([
      "harness.ts",
      "hooks/audit.ts",
      "harness/alpha.ts",
      "memory.ts",
      "harness/beta.ts",
    ]);
  });
});
