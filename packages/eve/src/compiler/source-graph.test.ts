import { describe, expect, it, vi } from "vitest";

import {
  composeAgentModuleCandidates,
  createAgentSourceRegistry,
  createProgrammaticModuleCandidates,
  defineProgrammaticAgentSource,
  instantiateProgrammaticTemplate,
  loadProgrammaticModuleNamespace,
  memoizeModuleNamespaceFactories,
  type AgentModuleBacking,
  type AgentModuleCandidate,
  type AgentSourceLayer,
  type AgentSourceOwner,
  type AgentSourceRegistration,
  type ProgrammaticAgentModule,
  type ProgrammaticAgentSource,
  type ProgrammaticModuleLoadContext,
} from "#compiler/source-graph.js";
import { materializeAuthoredModuleExport } from "#internal/authored-module.js";

function source(
  id: string,
  logicalPath: string,
  loadNamespace: ProgrammaticAgentModule["loadNamespace"] = async () => ({}),
): ProgrammaticAgentSource {
  return defineProgrammaticAgentSource({
    id,
    modules: [{ loadNamespace, logicalPath }],
    revision: `${id}:v1`,
  });
}

function candidate(
  registration: AgentSourceRegistration,
  layer: AgentSourceLayer,
  owner: AgentSourceOwner = { kind: "application" },
) {
  return createProgrammaticModuleCandidates({
    layer,
    nodeId: "node",
    owner,
    registration,
  })[0]!;
}

describe("derived programmatic sources", () => {
  it("memoizes definition factories within one module namespace", async () => {
    const factory = vi.fn(() => ({ instance: Symbol("definition") }));
    const firstNamespace = memoizeModuleNamespaceFactories({ default: factory });
    const secondNamespace = memoizeModuleNamespaceFactories({ default: factory });

    const first = await materializeAuthoredModuleExport(firstNamespace.default as () => unknown);
    const repeated = await materializeAuthoredModuleExport(firstNamespace.default as () => unknown);
    const second = await materializeAuthoredModuleExport(secondNamespace.default as () => unknown);

    expect(repeated).toBe(first);
    expect(second).not.toBe(first);
    expect(factory).toHaveBeenCalledTimes(2);
  });

  it("does not memoize calls that pass arguments", async () => {
    const exported = vi.fn((value?: string) => value ?? { instance: Symbol("definition") });
    const namespace = memoizeModuleNamespaceFactories({ default: exported });
    const callable = namespace.default as (value?: string) => unknown;

    const first = await materializeAuthoredModuleExport(callable);
    const repeated = await materializeAuthoredModuleExport(callable);

    expect(repeated).toBe(first);
    expect(callable("first")).toBe("first");
    expect(callable("second")).toBe("second");
    expect(exported).toHaveBeenCalledTimes(3);
  });

  it("loads registered templates with selected dependencies and serialized parameters", async () => {
    const dependencyNamespace = { default: { description: "GitHub connection" } };
    const loadTemplate = vi.fn(async (context: ProgrammaticModuleLoadContext) => ({
      default: context,
    }));
    const dependencySource = source(
      "test:connection",
      "connections/github.ts",
      async () => dependencyNamespace,
    );
    const templateSource = source(
      "test:connection-tool-template",
      "tools/connection-tool-template.ts",
      loadTemplate,
    );
    const registry = createAgentSourceRegistry([{ applyTo: "root", source: dependencySource }], {
      templates: [templateSource],
    });
    const [dependencyRegistration] = registry.registrations;
    const registeredTemplate = registry.templates.get(templateSource.id);
    if (dependencyRegistration === undefined || registeredTemplate === undefined) {
      throw new Error("Expected registered source and template.");
    }
    const dependency = candidate(dependencyRegistration, "application");
    const derived = instantiateProgrammaticTemplate({
      anchor: dependency,
      dependencies: { connection: dependency },
      logicalPath: "tools/github.ts",
      owner: { feature: "connection-tools", kind: "framework" },
      parameters: { connection: "github" },
      template: registeredTemplate,
    });

    expect(registry.registrations).toHaveLength(1);
    expect(registry.templates.has(templateSource.id)).toBe(true);
    expect(derived).toMatchObject({
      form: "derived",
      layer: "application",
      nodeId: "node",
      sourceId:
        "test:connection-tool-template:tools/github.ts:from:test:connection:connections/github.ts",
    });
    expect(composeAgentModuleCandidates([dependency, derived]).selected.get("tools/github")).toBe(
      derived,
    );

    const namespace = await loadProgrammaticModuleNamespace({
      backing: derived.backing as Extract<AgentModuleBacking, { kind: "programmatic" }>,
      dependencyNamespaces: { connection: dependencyNamespace },
      registries: [registry],
    });
    expect(namespace.default).toMatchObject({ parameters: { connection: "github" } });
    expect(loadTemplate).toHaveBeenCalledWith({
      dependencies: { connection: dependencyNamespace },
      parameters: { connection: "github" },
    });
  });

  it("inherits its anchor layer and yields to a direct target in that layer", () => {
    const templateSource = source(
      "test:connection-tool-template",
      "tools/connection-tool-template.ts",
    );
    const registry = createAgentSourceRegistry([], { templates: [templateSource] });
    const template = registry.templates.get(templateSource.id)!;
    const extensionOwner = {
      kind: "extension" as const,
      namespace: "github",
      packageName: "@acme/github",
    };
    const extensionConnection = candidate(
      { applyTo: "root", source: source("test:extension-connection", "connections/github.ts") },
      "extension-package",
      extensionOwner,
    );
    const applicationConnection = candidate(
      { applyTo: "root", source: source("test:application-connection", "connections/github.ts") },
      "application",
    );
    const directApplicationTool = candidate(
      { applyTo: "root", source: source("test:direct-tool", "tools/github.ts") },
      "application",
    );
    const derive = (anchor: AgentModuleCandidate) =>
      instantiateProgrammaticTemplate({
        anchor,
        dependencies: { connection: anchor },
        logicalPath: "tools/github.ts",
        owner: { feature: "connection-tools", kind: "framework" },
        template,
      });
    const extensionDerived = derive(extensionConnection);
    const applicationDerived = derive(applicationConnection);

    expect(extensionDerived.layer).toBe("extension-package");
    expect(applicationDerived.layer).toBe("application");
    expect(
      composeAgentModuleCandidates([
        extensionConnection,
        applicationConnection,
        extensionDerived,
        applicationDerived,
      ]).selected.get("tools/github"),
    ).toBe(applicationDerived);

    const composed = composeAgentModuleCandidates([
      extensionConnection,
      applicationConnection,
      extensionDerived,
      applicationDerived,
      directApplicationTool,
    ]);
    expect(composed.selected.get("tools/github")).toBe(directApplicationTool);
    expect(composed.composition.entries).toContainEqual(
      expect.objectContaining({
        kind: "shadowed",
        source: expect.objectContaining({ form: "derived", sourceId: applicationDerived.sourceId }),
        winnerSourceId: directApplicationTool.sourceId,
      }),
    );
  });

  it("rejects a selected derived source when its dependency was shadowed", () => {
    const dependencySource = source("test:dependency", "tools/input.ts");
    const replacementSource = source("test:dependency-replacement", "tools/input.ts");
    const templateSource = source("test:derived-template", "tools/template.ts");
    const registry = createAgentSourceRegistry([], { templates: [templateSource] });
    const template = registry.templates.get(templateSource.id)!;
    const dependency = candidate(
      { applyTo: "root", source: dependencySource },
      "extension-package",
      { kind: "extension", namespace: "example", packageName: "@acme/example" },
    );
    const replacement = candidate({ applyTo: "root", source: replacementSource }, "application");
    const derived = instantiateProgrammaticTemplate({
      anchor: dependency,
      dependencies: { input: dependency },
      logicalPath: "tools/output.ts",
      owner: { feature: "example", kind: "framework" },
      template,
    });

    expect(() => composeAgentModuleCandidates([dependency, replacement, derived])).toThrow(
      `Derived programmatic source "${derived.sourceId}" depends on unselected source "${dependency.sourceId}".`,
    );
  });

  it("rejects unregistered templates and invalid anchor dependencies", () => {
    const anchor = candidate(
      { applyTo: "root", source: source("test:anchor", "connections/input.ts") },
      "application",
    );
    const rawTemplateSource = source("test:raw-template", "tools/template.ts");
    const input = {
      anchor,
      dependencies: { input: anchor },
      logicalPath: "tools/output.ts",
      owner: { feature: "example", kind: "framework" } as const,
    };

    expect(() =>
      instantiateProgrammaticTemplate({
        ...input,
        template: { module: rawTemplateSource.modules[0]!, source: rawTemplateSource },
      }),
    ).toThrow("Derived programmatic modules require a registered template.");
    expect(() =>
      createAgentSourceRegistry([], {
        templates: [
          defineProgrammaticAgentSource({
            id: "test:multi-module-template",
            modules: [
              { loadNamespace: async () => ({}), logicalPath: "tools/first.ts" },
              { loadNamespace: async () => ({}), logicalPath: "tools/second.ts" },
            ],
            revision: "test:multi-module-template:v1",
          }),
        ],
      }),
    ).toThrow(
      'Programmatic template source "test:multi-module-template" must register exactly one module.',
    );

    const registry = createAgentSourceRegistry([], { templates: [rawTemplateSource] });
    const template = registry.templates.get(rawTemplateSource.id)!;
    const other = candidate(
      { applyTo: "root", source: source("test:other", "connections/other.ts") },
      "application",
    );
    expect(() =>
      instantiateProgrammaticTemplate({ ...input, dependencies: { other }, template }),
    ).toThrow("must include its anchor source as a dependency");
    expect(() =>
      instantiateProgrammaticTemplate({
        ...input,
        dependencies: { input: anchor, other: { ...other, nodeId: "other-node" } },
        template,
      }),
    ).toThrow(`cannot depend on source "${other.sourceId}" from another node`);
  });
});
