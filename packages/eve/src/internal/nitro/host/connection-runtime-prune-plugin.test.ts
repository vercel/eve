import { describe, expect, it } from "vitest";

import { createConnectionRuntimePrunePlugin } from "#internal/nitro/host/connection-runtime-prune-plugin.js";

function resolveAndLoad(source: string): string {
  const plugin = createConnectionRuntimePrunePlugin();
  const resolved = plugin.resolveId?.(source, undefined);
  if (resolved == null) {
    throw new Error(`Expected ${source} to resolve to a pruned runtime facade.`);
  }
  const id = typeof resolved === "string" ? resolved : resolved.id;
  const loaded = plugin.load?.(id);
  if (loaded == null) {
    throw new Error(`Expected ${source} to load a pruned runtime facade.`);
  }
  return loaded;
}

describe("createConnectionRuntimePrunePlugin", () => {
  it("replaces every connection-only runtime facade", () => {
    expect(resolveAndLoad("/repo/packages/eve/dist/src/runtime/connections/registry.js")).toContain(
      "export class ConnectionRegistryImpl",
    );
    expect(resolveAndLoad("#runtime/resolve-connection.js")).toContain(
      "export async function resolveConnectionDefinition",
    );
    expect(
      resolveAndLoad(
        "/repo/packages/eve/dist/src/runtime/framework-tools/connection-search-dynamic.js",
      ),
    ).toContain("export function createConnectionSearchResolver");
  });

  it("leaves non-connection runtime modules untouched", () => {
    const plugin = createConnectionRuntimePrunePlugin();

    expect(plugin.resolveId?.("#runtime/framework-tools/skill.js", undefined)).toBeNull();
    expect(
      plugin.resolveId?.("/repo/packages/eve/dist/src/runtime/resolve-agent.js", undefined),
    ).toBe(null);
  });
});
