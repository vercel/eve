import { describe, expect, it, vi } from "vitest";

import { createCompiledBindingNamespaceLoader } from "#compiler/load-binding-namespace.js";
import {
  createAgentSourceRegistry,
  defineProgrammaticAgentSource,
  type CompiledModuleBinding,
} from "#compiler/source-graph.js";

const mocks = vi.hoisted(() => ({
  loadAuthoredModuleNamespace: vi.fn(async () => ({ default: "dependency" })),
}));

vi.mock("#internal/authored-module-loader.js", () => ({
  loadAuthoredModuleNamespace: mocks.loadAuthoredModuleNamespace,
}));

describe("compiled binding namespace loader", () => {
  it("loads dependencies once and passes aliases and parameters to a template", async () => {
    const loadTemplate = vi.fn(async (context) => ({ default: context }));
    const template = defineProgrammaticAgentSource({
      id: "test:template",
      modules: [{ loadNamespace: loadTemplate, logicalPath: "tools/template.ts" }],
      revision: "test:template:v1",
    });
    const registry = createAgentSourceRegistry([], { templates: [template] });
    const bindings: Record<string, CompiledModuleBinding> = {
      dependency: {
        backing: {
          externalDependencies: [],
          kind: "filesystem",
          sourcePath: "/virtual/dependency.ts",
        },
        logicalPath: "tools/dependency.ts",
        owner: { kind: "application" },
      },
      derived: {
        backing: {
          dependencies: { source: "dependency" },
          kind: "programmatic",
          moduleId: "tools/template.ts",
          parameters: { slot: "derived" },
          registryId: template.id,
          revision: template.revision,
        },
        logicalPath: "tools/derived.ts",
        owner: { feature: "test", kind: "framework" },
      },
    };
    const loadNamespace = createCompiledBindingNamespaceLoader({
      bindings,
      registries: [registry],
    });

    const first = await loadNamespace("derived");
    const second = await loadNamespace("derived");
    await loadNamespace("dependency");

    expect(first).toBe(second);
    expect(mocks.loadAuthoredModuleNamespace).toHaveBeenCalledTimes(1);
    expect(loadTemplate).toHaveBeenCalledTimes(1);
    expect(loadTemplate).toHaveBeenCalledWith({
      dependencies: { source: { default: "dependency" } },
      parameters: { slot: "derived" },
    });
  });

  it("rejects dependency cycles before evaluating a template", async () => {
    const loadTemplate = vi.fn(async () => ({}));
    const template = defineProgrammaticAgentSource({
      id: "test:cyclic-template",
      modules: [{ loadNamespace: loadTemplate, logicalPath: "tools/template.ts" }],
      revision: "test:cyclic-template:v1",
    });
    const registry = createAgentSourceRegistry([], { templates: [template] });
    const programmatic = (dependency: string): CompiledModuleBinding => ({
      backing: {
        dependencies: { source: dependency },
        kind: "programmatic",
        moduleId: "tools/template.ts",
        registryId: template.id,
        revision: template.revision,
      },
      logicalPath: `tools/${dependency}.ts`,
      owner: { feature: "test", kind: "framework" },
    });
    const loadNamespace = createCompiledBindingNamespaceLoader({
      bindings: { first: programmatic("second"), second: programmatic("first") },
      registries: [registry],
    });

    await expect(loadNamespace("first")).rejects.toThrow(
      'Compiled binding dependency cycle includes "first".',
    );
    expect(loadTemplate).not.toHaveBeenCalled();
  });
});
