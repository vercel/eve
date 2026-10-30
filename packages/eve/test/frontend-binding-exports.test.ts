import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const EXPORT_FROM = /export\s+(?:type\s+)?\{([^}]*)\}\s+from\s+"([^"]+)"/g;
const BINDING_MODULE = /^#(?:react|vue|svelte)\//;

/** Names a binding entry point re-exports from shared modules, excluding its own hook module. */
function sharedExports(binding: "react" | "vue" | "svelte"): string[] {
  const source = readFileSync(new URL(`../src/${binding}/index.ts`, import.meta.url), "utf8");
  const names: string[] = [];
  for (const [, specifiers, from] of source.matchAll(EXPORT_FROM)) {
    if (BINDING_MODULE.test(from!)) continue;
    for (const specifier of specifiers!.split(",")) {
      const name = specifier.replace(/^\s*type\s+/, "").trim();
      if (name !== "") names.push(name);
    }
  }
  return names.sort();
}

describe("frontend binding entry points", () => {
  it("re-export the same shared client surface", () => {
    const react = sharedExports("react");
    expect(sharedExports("vue")).toEqual(react);
    expect(sharedExports("svelte")).toEqual(react);
  });
});
