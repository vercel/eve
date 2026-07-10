import { describe, expect, it } from "vitest";

import {
  createExtensionScopePlugin,
  createFixedNamespaceScopePlugin,
  type ExtensionScopeBundlerPlugin,
} from "#internal/bundler/extension-scope-plugin.js";

const SCOPES = [{ sourceRoot: "/pkg/crm/ext", packageNamespace: "acme-crm" }];

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
    const id = pathPlugin().resolveId("eve/context", "/pkg/crm/ext/tools/budget.ts");
    expect(id).toBe("\0eve-ext-scope:context:acme-crm");
  });

  it("redirects eve/extension to a namespaced shim for extension-owned importers", () => {
    const id = pathPlugin().resolveId("eve/extension", "/pkg/crm/ext/config.ts");
    expect(id).toBe("\0eve-ext-scope:extension:acme-crm");
  });

  it("ignores importers outside every extension source root", () => {
    expect(pathPlugin().resolveId("eve/context", "/app/agent/tools/local.ts")).toBeUndefined();
  });

  it("does not redirect a sibling directory that shares the source-root prefix", () => {
    expect(pathPlugin().resolveId("eve/context", "/pkg/crm/extras/tool.ts")).toBeUndefined();
  });

  it("only intercepts the scoped framework modules", () => {
    expect(pathPlugin().resolveId("eve/tools", "/pkg/crm/ext/tools/budget.ts")).toBeUndefined();
    expect(pathPlugin().resolveId("zod", "/pkg/crm/ext/tools/budget.ts")).toBeUndefined();
  });
});

describe("createFixedNamespaceScopePlugin (dev per-module)", () => {
  it("scopes every non-virtual importer to the fixed namespace", () => {
    const plugin = createFixedNamespaceScopePlugin("acme-crm");
    // The importer path is irrelevant in fixed mode.
    expect(plugin.resolveId("eve/context", "/anywhere/on/disk/tool.ts")).toBe(
      "\0eve-ext-scope:context:acme-crm",
    );
    expect(plugin.resolveId("eve/extension", "/anywhere/config.ts")).toBe(
      "\0eve-ext-scope:extension:acme-crm",
    );
  });

  it("never re-enters through virtual shim importers", () => {
    const plugin = createFixedNamespaceScopePlugin("acme-crm");
    expect(plugin.resolveId("eve/context", "\0eve-ext-scope:context:acme-crm")).toBeUndefined();
  });

  it("only intercepts the scoped framework modules", () => {
    const plugin = createFixedNamespaceScopePlugin("acme-crm");
    expect(plugin.resolveId("eve/tools", "/anywhere/tool.ts")).toBeUndefined();
  });
});

describe("shim baking (shared)", () => {
  it("bakes the namespace into the defineState shim", () => {
    const shim = createFixedNamespaceScopePlugin("acme-crm").load(
      "\0eve-ext-scope:context:acme-crm",
    );
    expect(shim?.code).toContain(
      `import { defineState as __eveScopedDefineState } from "eve/context"`,
    );
    expect(shim?.code).toContain(`__eveScopedDefineState("acme-crm" + "." + name, initial)`);
  });

  it("bakes the namespace into the defineExtension shim", () => {
    const shim = createFixedNamespaceScopePlugin("acme-crm").load(
      "\0eve-ext-scope:extension:acme-crm",
    );
    expect(shim?.code).toContain(`from "eve/extension"`);
    expect(shim?.code).toContain(`export function defineExtension(options, namespace)`);
    expect(shim?.code).toContain(`namespace === undefined ? "acme-crm" : namespace`);
  });

  it("passes through non-shim ids in load", () => {
    expect(pathPlugin().load("/pkg/crm/ext/tools/budget.ts")).toBeUndefined();
  });
});
