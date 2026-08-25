import { describe, expect, it, vi } from "vitest";

import {
  composeAgentModuleCandidates,
  createAgentSourceRegistry,
  createDerivedProgrammaticModuleCandidate,
  createProgrammaticModuleCandidates,
  defineProgrammaticAgentSource,
  loadProgrammaticModuleNamespace,
  type AgentModuleBacking,
  type AgentSourceLayer,
  type AgentSourceOwner,
  type AgentSourceRegistration,
  type ProgrammaticAgentModule,
  type ProgrammaticAgentSource,
  type ProgrammaticModuleLoadContext,
} from "#compiler/source-graph.js";

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
  it("loads registered templates with selected dependencies and serialized parameters", async () => {
    const dependencyNamespace = { default: { description: "Profile memory" } };
    const loadTemplate = vi.fn(async (context: ProgrammaticModuleLoadContext) => ({
      default: context,
    }));
    const dependencySource = source(
      "test:memory",
      "tools/profile-source.ts",
      async () => dependencyNamespace,
    );
    const replacementSource = source("test:replacement", "tools/profile.ts", async () => ({
      default: "replacement",
    }));
    const template = source("test:wrapper-template", "tools/wrapper-template.ts", loadTemplate);
    const registry = createAgentSourceRegistry(
      [
        { applyTo: "root", source: dependencySource },
        { applyTo: "root", source: replacementSource },
      ],
      { templates: [template] },
    );
    const [dependencyRegistration, replacementRegistration] = registry.registrations;
    const registeredTemplate = registry.templates.get(template.id);
    if (
      dependencyRegistration === undefined ||
      replacementRegistration === undefined ||
      registeredTemplate === undefined
    ) {
      throw new Error("Expected registered sources and template.");
    }
    const dependency = candidate(dependencyRegistration, "application");
    const replacement = candidate(replacementRegistration, "application");
    const derived = createDerivedProgrammaticModuleCandidate({
      dependencies: { memory: dependency },
      layer: "application",
      logicalPath: "tools/profile.ts",
      nodeId: "node",
      owner: { feature: "memory", kind: "framework" },
      parameters: { slot: "profile" },
      sourceId: "test:derived-profile",
      template: {
        moduleId: "tools/wrapper-template.ts",
        source: registeredTemplate,
      },
    });

    expect(registry.registrations).toHaveLength(2);
    expect(registry.templates.has(template.id)).toBe(true);
    expect(composeAgentModuleCandidates([dependency, derived]).selected.get("tools/profile")).toBe(
      derived,
    );
    const replaced = composeAgentModuleCandidates([dependency, derived, replacement]);
    expect(replaced.selected.get("tools/profile")).toBe(replacement);
    expect(replaced.composition.entries).toContainEqual(
      expect.objectContaining({
        kind: "shadowed",
        source: expect.objectContaining({ form: "derived", sourceId: derived.sourceId }),
        winnerSourceId: replacement.sourceId,
      }),
    );

    const namespace = await loadProgrammaticModuleNamespace({
      backing: derived.backing as Extract<AgentModuleBacking, { kind: "programmatic" }>,
      dependencyNamespaces: { memory: dependencyNamespace },
      registries: [registry],
    });
    expect(namespace.default).toMatchObject({ parameters: { slot: "profile" } });
    expect(loadTemplate).toHaveBeenCalledWith({
      dependencies: { memory: dependencyNamespace },
      parameters: { slot: "profile" },
    });
  });

  it("rejects a selected derived source when its dependency was shadowed", () => {
    const dependencySource = source("test:dependency", "tools/input.ts");
    const replacementSource = source("test:dependency-replacement", "tools/input.ts");
    const template = source("test:derived-template", "tools/template.ts");
    const dependency = candidate(
      { applyTo: "root", source: dependencySource },
      "extension-package",
      { kind: "extension", namespace: "example", packageName: "@acme/example" },
    );
    const replacement = candidate({ applyTo: "root", source: replacementSource }, "application");
    const derived = createDerivedProgrammaticModuleCandidate({
      dependencies: { input: dependency },
      layer: "application",
      logicalPath: "tools/output.ts",
      nodeId: "node",
      owner: { feature: "example", kind: "framework" },
      sourceId: "test:derived-output",
      template: { moduleId: "tools/template.ts", source: template },
    });

    expect(() => composeAgentModuleCandidates([dependency, replacement, derived])).toThrow(
      `Derived programmatic source "${derived.sourceId}" depends on unselected source "${dependency.sourceId}".`,
    );
  });
});
