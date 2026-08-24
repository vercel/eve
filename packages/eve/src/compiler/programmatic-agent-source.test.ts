import { describe, expect, it, vi } from "vitest";

import {
  defineProgrammaticAgentSource,
  type ProgrammaticAgentSource,
} from "#compiler/programmatic-agent-source.js";
import {
  composeAgentSourceRegistries,
  createAgentSourceRegistry,
  createFrameworkAgentSourceRegistry,
} from "#compiler/agent-source-registry.js";
import { composeRemainingAgentSources } from "#compiler/effective-agent-source-graph.js";
import { createAgentSourceManifest } from "#discover/manifest.js";

describe("defineProgrammaticAgentSource", () => {
  it("keeps namespaces lazy and freezes registration metadata", async () => {
    const marker = Symbol("definition");
    const definition = { execute: () => "ok", marker };
    const source = defineProgrammaticAgentSource({
      id: "eve.defaults",
      revision: "test-revision",
      modules: [
        {
          logicalPath: "tools/read_file.ts",
          loadNamespace: () => ({ default: definition }),
          semanticRevision: "read-file-v1",
        },
      ],
    });

    expect(Object.isFrozen(source)).toBe(true);
    expect(Object.isFrozen(source.modules)).toBe(true);
    expect(Object.isFrozen(source.modules[0])).toBe(true);
    expect(source.modules[0]?.semanticRevision).toBe("read-file-v1");
    expect(await source.modules[0]?.loadNamespace()).toEqual({ default: definition });
  });

  it.each(["/tools/read.ts", "../tools/read.ts", "tools//read.ts", "tools/read.txt"])(
    "rejects invalid module path %s",
    (logicalPath) => {
      expect(() =>
        defineProgrammaticAgentSource({
          id: "eve.invalid",
          revision: "test-revision",
          modules: [{ logicalPath, loadNamespace: () => ({}) }],
        }),
      ).toThrow();
    },
  );

  it("rejects duplicate paths", () => {
    expect(() =>
      defineProgrammaticAgentSource({
        id: "eve.duplicate",
        revision: "test-revision",
        modules: [
          { logicalPath: "sandbox.ts", loadNamespace: () => ({}) },
          { logicalPath: "sandbox.ts", loadNamespace: () => ({}) },
        ],
      }),
    ).toThrow('declares "sandbox.ts" more than once');
  });

  it("rejects the deleted eager namespace registration shape", () => {
    expect(() =>
      defineProgrammaticAgentSource({
        id: "eve.eager",
        revision: "test-revision",
        modules: [
          {
            logicalPath: "tools/read.ts",
            namespace: { default: {} },
          } as never,
        ],
      }),
    ).toThrow("must expose a lazy loadNamespace() function");
  });

  it("rejects an empty module semantic revision", () => {
    expect(() =>
      defineProgrammaticAgentSource({
        id: "eve.invalid-semantic-revision",
        revision: "test-revision",
        modules: [
          {
            logicalPath: "sandbox.ts",
            loadNamespace: () => ({}),
            semanticRevision: "",
          },
        ],
      }),
    ).toThrow("must declare a non-empty semantic revision");
  });
});

describe("programmatic source registration", () => {
  it("creates deterministic application candidates for eligible nodes", () => {
    const source = defineProgrammaticAgentSource({
      id: "eve.defaults",
      revision: "test-revision",
      modules: [
        {
          logicalPath: "tools/read_file.ts",
          loadNamespace: () => ({}),
          semanticRevision: "read-file-v1",
        },
      ],
    });
    const registry = createAgentSourceRegistry([{ applyTo: "all-local-nodes", source }]);

    expect(
      composeRemainingAgentSources({
        externalDependencies: [],
        isRoot: false,
        manifest: createAgentSourceManifest({ agentRoot: "/app/agent", appRoot: "/app" }),
        nodeId: "subagents/research",
        registry,
      }).winners,
    ).toMatchObject([
      {
        descriptor: {
          backing: {
            kind: "programmatic",
            moduleId: "tools/read_file.ts",
            registryId: "eve.defaults",
            revision: "test-revision",
            semanticRevision: "read-file-v1",
          },
          layer: "application",
          logicalPath: "tools/read_file.ts",
          owner: { kind: "application" },
          sourceId: "eve.defaults:tools/read_file.ts",
          sourceKind: "module",
        },
        kind: "tool",
        nodeId: "subagents/research",
        slot: "tools/read_file",
        source: {
          logicalPath: "tools/read_file.ts",
          sourceId: "eve.defaults:tools/read_file.ts",
          sourceKind: "module",
        },
      },
    ]);
  });

  it.each(["schedules/daily.ts", "instrumentation.ts", "instrumentation/local.ts"])(
    "rejects graph- or host-expanding all-node module %s",
    (logicalPath) => {
      const source = defineProgrammaticAgentSource({
        id: "eve.invalid",
        revision: "test-revision",
        modules: [{ logicalPath, loadNamespace: () => ({}) }],
      });
      expect(() => createAgentSourceRegistry([{ applyTo: "all-local-nodes", source }])).toThrow(
        "can expand the graph or host surface",
      );
    },
  );

  it.each(["extensions/crm.ts", "subagents/research.ts"])(
    "rejects structurally incomplete root programmatic module %s",
    (logicalPath) => {
      const source: ProgrammaticAgentSource = {
        id: "app.invalid-structure",
        revision: "test-revision",
        modules: [{ logicalPath, loadNamespace: () => ({}) }],
      };

      expect(() => createAgentSourceRegistry([{ applyTo: "root", source }])).toThrow(
        "require discovered structural source records",
      );
    },
  );

  it("keeps all-node agent config registration unavailable to ordinary registries", () => {
    const source = defineProgrammaticAgentSource({
      id: "app.defaults",
      revision: "test-revision",
      modules: [{ logicalPath: "agent.ts", loadNamespace: () => ({}) }],
    });

    expect(() => createAgentSourceRegistry([{ applyTo: "all-local-nodes", source }])).toThrow(
      "can expand the graph or host surface",
    );
  });

  it("permits only the exact framework-owned agent.ts default candidate", () => {
    const framework = defineProgrammaticAgentSource({
      id: "eve.framework",
      revision: "test-revision",
      modules: [{ logicalPath: "agent.ts", loadNamespace: () => ({}) }],
    });
    const registry = createFrameworkAgentSourceRegistry({
      frameworkDefaultConfigSource: framework,
      registrations: [{ applyTo: "all-local-nodes", source: framework }],
    });

    expect(registry.registrations).toHaveLength(1);
    expect(registry.registrations[0]).toMatchObject({
      layer: "framework-default",
      owner: { feature: "eve.framework", kind: "framework" },
    });

    const graphExpander = defineProgrammaticAgentSource({
      id: "eve.graph-expander",
      revision: "test-revision",
      modules: [{ logicalPath: "channels/root.ts", loadNamespace: () => ({}) }],
    });
    expect(() =>
      createFrameworkAgentSourceRegistry({
        frameworkDefaultConfigSource: graphExpander,
        registrations: [{ applyTo: "all-local-nodes", source: graphExpander }],
      }),
    ).toThrow('must declare exact module "agent.ts"');

    const defaultWithGraphExpansion = defineProgrammaticAgentSource({
      id: "eve.invalid-default",
      revision: "test-revision",
      modules: [
        { logicalPath: "agent.ts", loadNamespace: () => ({}) },
        { logicalPath: "channels/root.ts", loadNamespace: () => ({}) },
      ],
    });
    expect(() =>
      createFrameworkAgentSourceRegistry({
        frameworkDefaultConfigSource: defaultWithGraphExpansion,
        registrations: [{ applyTo: "all-local-nodes", source: defaultWithGraphExpansion }],
      }),
    ).toThrow("can expand the graph or host surface");
  });

  it("composes application additions without relabeling framework registrations", async () => {
    const loadFramework = vi.fn(() => ({ default: "framework" }));
    const framework = defineProgrammaticAgentSource({
      id: "eve.framework",
      revision: "framework-revision",
      modules: [
        { logicalPath: "agent.ts", loadNamespace: () => ({ default: {} }) },
        { logicalPath: "tools/read_file.ts", loadNamespace: loadFramework },
      ],
    });
    const frameworkRegistry = createFrameworkAgentSourceRegistry({
      frameworkDefaultConfigSource: framework,
      registrations: [{ applyTo: "all-local-nodes", source: framework }],
    });
    const loadApplication = vi.fn(() => ({ default: "application" }));
    const application = defineProgrammaticAgentSource({
      id: "memory.application",
      revision: "application-revision",
      modules: [{ logicalPath: "tools/search.ts", loadNamespace: loadApplication }],
    });
    const applicationRegistry = createAgentSourceRegistry([
      { applyTo: "root", source: application },
    ]);

    const registry = composeAgentSourceRegistries([frameworkRegistry, applicationRegistry]);

    expect(registry.registrations[0]).toBe(frameworkRegistry.registrations[0]);
    expect(registry.registrations[1]).toBe(applicationRegistry.registrations[0]);
    expect(registry.registrations).toMatchObject([
      {
        layer: "framework-default",
        owner: { feature: "eve.framework", kind: "framework" },
        source: { id: "eve.framework" },
      },
      {
        layer: "application",
        owner: { kind: "application" },
        source: { id: "memory.application" },
      },
    ]);
    await expect(
      registry.loadModule({
        kind: "programmatic",
        moduleId: "tools/read_file.ts",
        registryId: "eve.framework",
        revision: "framework-revision",
      }),
    ).resolves.toEqual({ default: "framework" });
    await expect(
      registry.loadModule({
        kind: "programmatic",
        moduleId: "tools/search.ts",
        registryId: "memory.application",
        revision: "application-revision",
      }),
    ).resolves.toEqual({ default: "application" });
    expect(loadFramework).toHaveBeenCalledOnce();
    expect(loadApplication).toHaveBeenCalledOnce();
  });

  it("rejects duplicate source ids across composed registries", () => {
    const source = () =>
      defineProgrammaticAgentSource({
        id: "duplicate",
        revision: "test-revision",
        modules: [{ logicalPath: "tools/search.ts", loadNamespace: () => ({}) }],
      });

    expect(() =>
      composeAgentSourceRegistries([
        createAgentSourceRegistry([{ applyTo: "root", source: source() }]),
        createAgentSourceRegistry([{ applyTo: "root", source: source() }]),
      ]),
    ).toThrow('Programmatic agent source id "duplicate" is registered twice.');
  });
});
