import { describe, expect, it } from "vitest";

import {
  createExtensionScopePlugin,
  createFixedMountScopePlugin,
  type ExtensionScopeBundlerPlugin,
} from "#internal/bundler/extension-scope-plugin.js";

const SCOPES = [{ sourceRoot: "/pkg/crm/extension", mountId: "extensions/crm" }];

function pathPlugin(): ExtensionScopeBundlerPlugin {
  const created = createExtensionScopePlugin(SCOPES);
  if (created === null) {
    throw new Error("expected a plugin for a non-empty scope set");
  }
  return created;
}

describe("createExtensionScopePlugin (path containment)", () => {
  it("returns null when there are no extensions so non-extension builds are untouched", () => {
    expect(createExtensionScopePlugin([])).toBeNull();
  });

  it("redirects eve/context to a namespaced shim for extension-owned importers", () => {
    const id = pathPlugin().resolveId("eve/context", "/pkg/crm/extension/tools/budget.ts");
    expect(id).toBe("\0eve-ext-scope:context:extensions%2Fcrm");
  });

  it("uses the tagged mount when two instances share a source root", () => {
    const plugin = createExtensionScopePlugin([
      ...SCOPES,
      { ...SCOPES[0]!, mountId: "subagents/research/extensions/crm" },
    ])!;
    expect(
      plugin.resolveId(
        "eve/context",
        "/pkg/crm/extension/tools/budget.ts?eve-mount=subagents%2Fresearch%2Fextensions%2Fcrm",
      ),
    ).toBe("\0eve-ext-scope:context:subagents%2Fresearch%2Fextensions%2Fcrm");
    expect(() => plugin.resolveId("eve/context", "/pkg/crm/extension/tools/budget.ts")).toThrow(
      "Ambiguous extension scope",
    );
  });

  it("scopes a shared chunk emitted beside the source root to its tagged mount", () => {
    const plugin = createExtensionScopePlugin([
      ...SCOPES,
      { ...SCOPES[0]!, mountId: "subagents/research/extensions/crm" },
    ])!;
    expect(
      plugin.resolveId(
        "eve/context",
        "/pkg/crm/_chunks/budget-abc123.mjs?eve-mount=subagents%2Fresearch%2Fextensions%2Fcrm",
      ),
    ).toBe("\0eve-ext-scope:context:subagents%2Fresearch%2Fextensions%2Fcrm");
  });

  it("leaves eve/extension unscoped for extension-owned importers", () => {
    const id = pathPlugin().resolveId("eve/extension", "/pkg/crm/extension/config.ts");
    expect(id).toBeUndefined();
  });

  it("ignores importers outside every extension source root", () => {
    expect(pathPlugin().resolveId("eve/context", "/app/agent/tools/local.ts")).toBeUndefined();
  });

  it("does not redirect a sibling directory that shares the source-root prefix", () => {
    expect(pathPlugin().resolveId("eve/context", "/pkg/crm/extras/tool.ts")).toBeUndefined();
  });

  it("only intercepts the scoped framework modules", () => {
    expect(
      pathPlugin().resolveId("eve/tools", "/pkg/crm/extension/tools/budget.ts"),
    ).toBeUndefined();
    expect(pathPlugin().resolveId("zod", "/pkg/crm/extension/tools/budget.ts")).toBeUndefined();
  });
});

describe("createFixedMountScopePlugin (dev per-module)", () => {
  it("scopes every non-virtual importer to the fixed namespace", () => {
    const plugin = createFixedMountScopePlugin("extensions/crm");
    // The importer path is irrelevant in fixed mode.
    expect(plugin.resolveId("eve/context", "/anywhere/on/disk/tool.ts")).toBe(
      "\0eve-ext-scope:context:extensions%2Fcrm",
    );
    expect(plugin.resolveId("eve/extension", "/anywhere/config.ts")).toBeUndefined();
  });

  it("never re-enters through virtual shim importers", () => {
    const plugin = createFixedMountScopePlugin("extensions/crm");
    expect(
      plugin.resolveId("eve/context", "\0eve-ext-scope:context:extensions%2Fcrm"),
    ).toBeUndefined();
  });

  it("only intercepts the scoped framework modules", () => {
    const plugin = createFixedMountScopePlugin("extensions/crm");
    expect(plugin.resolveId("eve/tools", "/anywhere/tool.ts")).toBeUndefined();
  });
});

describe("shim baking (shared)", () => {
  it("bakes the namespace into the defineState shim", () => {
    const shim = createFixedMountScopePlugin("extensions/crm").load(
      "\0eve-ext-scope:context:extensions%2Fcrm",
    );
    expect(shim?.code).toContain(`import { defineMountedState } from "eve/internal/mount-state"`);
    expect(shim?.code).toContain(`defineMountedState("extensions/crm", name, initial)`);
  });

  it("passes through non-shim ids in load", () => {
    expect(pathPlugin().load("/pkg/crm/extension/tools/budget.ts")).toBeUndefined();
  });
});
