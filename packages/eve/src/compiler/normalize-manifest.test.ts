import { beforeEach, describe, expect, it, vi } from "vitest";

import { z } from "#compiled/zod/index.js";
import type { AgentSourceManifest } from "#discover/manifest.js";
import {
  createAgentSourceManifest,
  createLocalSubagentSourceRef,
  createModuleSourceRef,
  createSkillPackageSourceRef,
} from "#discover/manifest.js";
import { classifyModelRouting } from "#internal/classify-model-routing.js";
import type { CompiledAgentDefinition } from "#compiler/manifest.js";
import { createAgentSourceRegistry } from "#compiler/agent-source-registry.js";
import { defineProgrammaticAgentSource } from "#compiler/programmatic-agent-source.js";
import { compileAgentManifest } from "#compiler/normalize-manifest.js";
import { parseCompiledAgentManifest } from "#compiler/compiled-manifest-validation.js";
import { collectModuleRefsForManifest } from "#compiler/module-map.js";
import { collectCompiledModuleScopes } from "#compiler/module-scope.js";
import { assertCompiledAgentManifestSemantics } from "#compiler/module-binding.js";
import { defineAgent, defineDynamic } from "#public/definitions/agent.js";
import { defineInstructions } from "#public/definitions/instructions.js";
import { defineTool, experimental_workflow } from "#public/definitions/tool.js";
import { defineChannel, disableRoute, GET } from "#public/definitions/channel.js";
import { webSearch } from "#public/tools/web-search.js";
import {
  SOURCE_NORMALIZATION_FAILED_DIAGNOSTIC_CODE,
  SourceNormalizationError,
} from "#compiler/normalize-helpers.js";

const mocks = vi.hoisted(() => ({
  applicationDefinition: vi.fn(),
  compileAgentConfig: vi.fn(),
  loadModuleBackedDefinition: vi.fn(),
}));

vi.mock("#compiler/normalize-agent-config.js", () => ({
  compileAgentConfig: async (
    manifest: AgentSourceManifest,
    context: unknown,
    options: unknown,
  ) => ({
    ...(await mocks.compileAgentConfig(manifest, context, options)),
    source: manifest.configModule!,
  }),
}));

vi.mock("#compiler/normalize-helpers.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("#compiler/normalize-helpers.js")>()),
  loadModuleBackedDefinition: mocks.loadModuleBackedDefinition,
}));

describe("compileAgentManifest", () => {
  beforeEach(() => {
    mocks.applicationDefinition.mockReset();
    mocks.compileAgentConfig.mockReset();
    mocks.loadModuleBackedDefinition.mockReset();
    mocks.loadModuleBackedDefinition.mockImplementation(async (input) => {
      if (input.binding?.backing.kind !== "programmatic") {
        return await mocks.applicationDefinition(input);
      }
      const namespace = await input.moduleLoader.load(input.binding.backing);
      const value = namespace[input.source.exportName ?? "default"];
      return typeof value === "function" ? await value() : value;
    });
  });

  it("compiles the framework default as the root config source", async () => {
    mocks.compileAgentConfig.mockResolvedValue(createConfig({ name: "root" }));
    const compiled = await compileAgentManifest(
      createAgentSourceManifest({
        agentId: "root",
        agentRoot: "/app/agent",
        appRoot: "/app",
      }),
    );

    expect(compiled.config.source).toEqual({
      exportName: undefined,
      logicalPath: "agent.ts",
      sourceId: "eve.framework-defaults:agent.ts",
      sourceKind: "module",
    });
    expect(compiled.bindings[compiled.config.source.sourceId]).toMatchObject({
      logicalPath: "agent.ts",
      owner: { feature: "eve.framework-defaults", kind: "framework" },
    });
    expect(compiled.sourceComposition.selected).toContainEqual({
      slot: "agent",
      sourceId: "eve.framework-defaults:agent.ts",
      sourceKind: "module",
    });
  });

  it("compiles an authored config as the application-owned replacement", async () => {
    mocks.compileAgentConfig.mockResolvedValue(createConfig({ name: "root" }));
    mocks.applicationDefinition.mockResolvedValue(defineAgent({ model: "openai/gpt-5.5" }));
    const compiled = await compileAgentManifest(
      createAgentSourceManifest({
        agentId: "root",
        agentRoot: "/app/agent",
        appRoot: "/app",
        configModule: createModuleSourceRef({
          logicalPath: "agent.ts",
          sourceId: "application-agent-config",
        }),
      }),
    );

    expect(compiled.config.source.sourceId).toBe("application-agent-config");
    expect(compiled.bindings["application-agent-config"]?.owner).toEqual({
      kind: "application",
    });
    expect(compiled.bindings).not.toHaveProperty("eve.framework-defaults:agent.ts");
    expect(compiled.sourceComposition.shadowed).toContainEqual(
      expect.objectContaining({
        slot: "agent",
        source: expect.objectContaining({ sourceId: "eve.framework-defaults:agent.ts" }),
        winningSourceId: "application-agent-config",
      }),
    );
  });

  it("allows application sources to disable the ordinary home framework channel", async () => {
    mocks.compileAgentConfig.mockResolvedValue(createConfig({ name: "root" }));
    mocks.applicationDefinition.mockResolvedValue(disableRoute());
    const manifest = createAgentSourceManifest({
      agentId: "root",
      agentRoot: "/app/agent",
      appRoot: "/app",
      channels: [createModuleSourceRef({ logicalPath: "channels/home.ts" })],
    });

    const compiled = await compileAgentManifest(manifest);

    expect(compiled.channelRoutes.effective).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ logicalPath: "channels/home.ts" })]),
    );
    expect(compiled.channelRoutes.effective).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: "channel", name: "eve/v1/health" })]),
    );
  });

  it("selects the framework local-tracing primitive when providers are off", async () => {
    mocks.compileAgentConfig.mockResolvedValue(createConfig({ name: "root" }));

    const compiled = await compileAgentManifest(
      createAgentSourceManifest({
        agentId: "root",
        agentRoot: "/app/agent",
        appRoot: "/app",
      }),
    );

    expect(compiled.instrumentation).toMatchObject({
      entry: {
        activation: "development",
        implementation: "local-tracing",
        source: { logicalPath: "instrumentation.ts" },
      },
      kind: "file",
    });
  });

  it("selects explicit production and development framework provider slots", async () => {
    mocks.compileAgentConfig.mockResolvedValue(
      createConfig({ experimental: { instrumentationProviders: true }, name: "root" }),
    );

    const compiled = await compileAgentManifest(
      createAgentSourceManifest({
        agentId: "root",
        agentRoot: "/app/agent",
        appRoot: "/app",
      }),
    );

    expect(compiled.instrumentation).toMatchObject({
      entries: [
        { activation: "production", slot: "agent-runs" },
        { activation: "development", slot: "local" },
      ],
      kind: "providers",
    });
  });

  it("rejects an instrumentation plan that disagrees with its selected owner", async () => {
    mocks.compileAgentConfig.mockResolvedValue(
      createConfig({ experimental: { instrumentationProviders: true }, name: "root" }),
    );
    const compiled = await compileAgentManifest(
      createAgentSourceManifest({
        agentId: "root",
        agentRoot: "/app/agent",
        appRoot: "/app",
      }),
    );
    if (compiled.instrumentation.kind !== "providers") throw new Error("Expected provider plan.");
    const malformed = {
      ...compiled,
      instrumentation: {
        ...compiled.instrumentation,
        entries: compiled.instrumentation.entries.map((entry, index) =>
          index === 0 ? { ...entry, activation: "development" as const } : entry,
        ),
      },
    };

    expect(() => assertCompiledAgentManifestSemantics(malformed)).toThrow(
      'Compiled instrumentation plan for slot "instrumentation/agent-runs" does not match its selected owner.',
    );
  });

  it("rejects Workflow runtime configuration on subagents", async () => {
    const subagentManifest = createAgentSourceManifest({
      agentId: "research",
      agentRoot: "/app/agent/subagents/research",
      appRoot: "/app",
      configModule: createModuleSourceRef({
        logicalPath: "agent.ts",
      }),
    });
    const manifest = createAgentSourceManifest({
      agentId: "root",
      agentRoot: "/app/agent",
      appRoot: "/app",
      subagents: [
        createLocalSubagentSourceRef({
          entryPath: "subagents/research/agent.ts",
          logicalPath: "subagents/research",
          manifest: subagentManifest,
          rootPath: "/app/agent/subagents/research",
          subagentId: "research",
        }),
      ],
    });

    mocks.compileAgentConfig.mockImplementation(async (input: AgentSourceManifest) => {
      if (input.agentId === "research") {
        throw new Error(
          'Workflow runtime configuration is only supported on the root agent config. Remove "experimental.workflow" from "research".',
        );
      }

      return createConfig({ name: "root" });
    });
    mocks.applicationDefinition.mockResolvedValue({
      description: "Research subagent",
      model: "openai/gpt-5.5",
    });

    await expect(compileAgentManifest(manifest)).rejects.toThrow(
      'Remove "experimental.workflow" from "research"',
    );
  });

  it("supplements framework defaults with application programmatic sources", async () => {
    const manifest = createAgentSourceManifest({
      agentId: "root",
      agentRoot: "/app/agent",
      appRoot: "/app",
    });
    mocks.compileAgentConfig.mockResolvedValue(createConfig({ name: "root" }));
    const loadApplication = vi.fn(() => ({
      default: defineTool({
        description: "Search application memory.",
        execute: async () => null,
        inputSchema: z.object({}),
      }),
    }));
    const applicationSource = defineProgrammaticAgentSource({
      id: "memory.application",
      revision: "test-revision",
      modules: [{ loadNamespace: loadApplication, logicalPath: "tools/search.ts" }],
    });
    const registry = createAgentSourceRegistry([{ applyTo: "root", source: applicationSource }]);

    const compiled = await compileAgentManifest(manifest, { registry });

    expect(compiled.config.source.sourceId).toBe("eve.framework-defaults:agent.ts");
    expect(compiled.bindings["memory.application:tools/search.ts"]).toMatchObject({
      logicalPath: "tools/search.ts",
      owner: { kind: "application" },
    });
    expect(compiled.tools).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "search" })]),
    );
    expect(loadApplication).toHaveBeenCalledOnce();
  });

  it("rejects distinct tool slots that flatten to the same public name", async () => {
    mocks.compileAgentConfig.mockResolvedValue(createConfig({ name: "root" }));
    mocks.applicationDefinition.mockResolvedValue(
      defineTool({
        description: "Colliding tool.",
        execute: async () => null,
        inputSchema: z.object({}),
      }),
    );

    const error = await compileAgentManifest(
      createAgentSourceManifest({
        agentId: "root",
        agentRoot: "/app/agent",
        appRoot: "/app",
        tools: [
          createModuleSourceRef({ logicalPath: "tools/a/b.ts" }),
          createModuleSourceRef({ logicalPath: "tools/a-b.ts" }),
        ],
      }),
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe(
      'Tool sources "tools/a-b.ts" and "tools/a/b.ts" both flatten to public name "a-b". Rename one source so every logical slot has a unique tool name.',
    );
    expect(
      mocks.applicationDefinition.mock.calls
        .map(([input]) => (input as { source: { logicalPath: string } }).source.logicalPath)
        .sort(),
    ).toEqual(["tools/a-b.ts", "tools/a/b.ts"]);
  });

  it("reports invalid filesystem and programmatic exports through one diagnostic contract", async () => {
    mocks.compileAgentConfig.mockResolvedValue(createConfig({ name: "root" }));
    mocks.applicationDefinition.mockResolvedValue({ invalid: true });
    const filesystemError = await compileAgentManifest(
      createAgentSourceManifest({
        agentId: "root",
        agentRoot: "/app/agent",
        appRoot: "/app",
        tools: [createModuleSourceRef({ logicalPath: "tools/search.ts" })],
      }),
    ).catch((error: unknown) => error);

    const invalidProgrammaticSource = defineProgrammaticAgentSource({
      id: "memory.invalid",
      revision: "test-revision",
      modules: [
        { loadNamespace: () => ({ default: { invalid: true } }), logicalPath: "tools/search.ts" },
      ],
    });
    const programmaticError = await compileAgentManifest(
      createAgentSourceManifest({
        agentId: "root",
        agentRoot: "/app/agent",
        appRoot: "/app",
      }),
      {
        registry: createAgentSourceRegistry([
          { applyTo: "root", source: invalidProgrammaticSource },
        ]),
      },
    ).catch((error: unknown) => error);

    expect(filesystemError).toBeInstanceOf(SourceNormalizationError);
    expect(programmaticError).toBeInstanceOf(SourceNormalizationError);
    const filesystemDiagnostic = (filesystemError as SourceNormalizationError).diagnostic;
    const programmaticDiagnostic = (programmaticError as SourceNormalizationError).diagnostic;
    expect(filesystemDiagnostic).toMatchObject({
      code: SOURCE_NORMALIZATION_FAILED_DIAGNOSTIC_CODE,
      logicalPath: "tools/search.ts",
      nodeId: "__root__",
      severity: "error",
      sourceId: "tools/search.ts",
      sourcePath: "/app/agent/tools/search.ts",
    });
    expect(programmaticDiagnostic).toMatchObject({
      code: SOURCE_NORMALIZATION_FAILED_DIAGNOSTIC_CODE,
      logicalPath: "tools/search.ts",
      nodeId: "__root__",
      severity: "error",
      sourceId: "memory.invalid:tools/search.ts",
    });
    expect(programmaticDiagnostic).not.toHaveProperty("sourcePath");
  });

  it("lets an application programmatic config shadow the framework default", async () => {
    mocks.compileAgentConfig.mockResolvedValue(createConfig({ name: "root" }));
    const loadApplication = vi.fn(() => ({
      default: defineAgent({ model: "openai/gpt-5.5" }),
    }));
    const applicationSource = defineProgrammaticAgentSource({
      id: "memory.application",
      revision: "test-revision",
      modules: [{ loadNamespace: loadApplication, logicalPath: "agent.ts" }],
    });
    const registry = createAgentSourceRegistry([{ applyTo: "root", source: applicationSource }]);

    const compiled = await compileAgentManifest(
      createAgentSourceManifest({
        agentId: "root",
        agentRoot: "/app/agent",
        appRoot: "/app",
      }),
      { registry },
    );

    expect(compiled.config.source.sourceId).toBe("memory.application:agent.ts");
    expect(compiled.bindings["memory.application:agent.ts"]?.owner).toEqual({
      kind: "application",
    });
    expect(compiled.sourceComposition.shadowed).toContainEqual(
      expect.objectContaining({
        slot: "agent",
        source: expect.objectContaining({ sourceId: "eve.framework-defaults:agent.ts" }),
        winningSourceId: "memory.application:agent.ts",
      }),
    );
    expect(loadApplication).toHaveBeenCalledOnce();
  });

  it("removes the native agent capability when a selected child owns that runtime name", async () => {
    const childManifest = createAgentSourceManifest({
      agentId: "agent",
      agentRoot: "/app/agent/subagents/agent",
      appRoot: "/app",
      configModule: createModuleSourceRef({ logicalPath: "agent.ts" }),
    });
    const manifest = createAgentSourceManifest({
      agentId: "root",
      agentRoot: "/app/agent",
      appRoot: "/app",
      subagents: [
        createLocalSubagentSourceRef({
          entryPath: "subagents/agent/agent.ts",
          logicalPath: "subagents/agent",
          manifest: childManifest,
          rootPath: "/app/agent/subagents/agent",
          subagentId: "agent",
        }),
      ],
    });
    mocks.compileAgentConfig.mockImplementation(async (input: AgentSourceManifest) =>
      createConfig({
        description: input.agentId === "agent" ? "Delegates through the named child." : undefined,
        name: input.agentId,
      }),
    );
    mocks.applicationDefinition.mockResolvedValue({
      description: "Delegates through the named child.",
      model: "openai/gpt-5.5",
    });

    const compiled = await compileAgentManifest(manifest);

    expect(compiled.kernelPlan.prepared).not.toContain("agent");
    expect(compiled.sourceComposition.selected).toContainEqual(
      expect.objectContaining({ slot: "subagents/agent", sourceKind: "non-module" }),
    );
  });

  it.each([
    { subagentKind: "local", toolKind: "static" },
    { subagentKind: "remote", toolKind: "dynamic" },
  ] as const)(
    "rejects a $toolKind tool whose runtime name collides with a direct $subagentKind subagent",
    async ({ subagentKind, toolKind }) => {
      const subagentManifest = createAgentSourceManifest({
        agentId: "researcher",
        agentRoot: "/app/agent/subagents/researcher",
        appRoot: "/app",
        configModule: createModuleSourceRef({ logicalPath: "agent.ts" }),
      });
      const manifest = createAgentSourceManifest({
        agentId: "root",
        agentRoot: "/app/agent",
        appRoot: "/app",
        subagents: [
          createLocalSubagentSourceRef({
            entryPath: "subagents/researcher/agent.ts",
            logicalPath: "subagents/researcher",
            manifest: subagentManifest,
            rootPath: "/app/agent/subagents/researcher",
            subagentId: "researcher",
          }),
        ],
        tools: [createModuleSourceRef({ logicalPath: "tools/researcher.ts" })],
      });
      mocks.compileAgentConfig.mockImplementation(async (input: AgentSourceManifest) =>
        createConfig({
          description: input.agentId === "researcher" ? "Research the request." : undefined,
          name: input.agentId,
        }),
      );
      mocks.applicationDefinition.mockImplementation(
        async (input: { source: { logicalPath: string } }) => {
          if (input.source.logicalPath === "tools/researcher.ts") {
            return toolKind === "static"
              ? defineTool({
                  description: "Research the request.",
                  execute: async () => null,
                  inputSchema: z.object({}),
                })
              : defineDynamic({ events: { "session.started": () => null } });
          }
          return subagentKind === "local"
            ? defineAgent({
                description: "Research the request.",
                model: "openai/gpt-5.5",
              })
            : {
                description: "Research the request.",
                kind: "remote",
                path: "/eve/v1/session",
                url: "https://remote.example.com",
              };
        },
      );

      await expect(compileAgentManifest(manifest)).rejects.toThrow(
        `runtime capability name "researcher" collides between ${
          toolKind === "static" ? "tool" : "dynamic tool"
        } source "tools/researcher.ts" and subagent source "subagents/researcher"`,
      );
    },
  );

  it("rejects a direct subagent with a reserved kernel runtime name", async () => {
    const subagentManifest = createAgentSourceManifest({
      agentId: "final_output",
      agentRoot: "/app/agent/subagents/final_output",
      appRoot: "/app",
      configModule: createModuleSourceRef({ logicalPath: "agent.ts" }),
    });
    const manifest = createAgentSourceManifest({
      agentId: "root",
      agentRoot: "/app/agent",
      appRoot: "/app",
      subagents: [
        createLocalSubagentSourceRef({
          entryPath: "subagents/final_output/agent.ts",
          logicalPath: "subagents/final_output",
          manifest: subagentManifest,
          rootPath: "/app/agent/subagents/final_output",
          subagentId: "final_output",
        }),
      ],
    });
    mocks.compileAgentConfig.mockImplementation(async (input: AgentSourceManifest) =>
      createConfig({
        description: input.agentId === "final_output" ? "Return the final answer." : undefined,
        name: input.agentId,
      }),
    );
    mocks.applicationDefinition.mockResolvedValue(
      defineAgent({
        description: "Return the final answer.",
        model: "openai/gpt-5.5",
      }),
    );

    await expect(compileAgentManifest(manifest)).rejects.toThrow(
      'runtime capability name "final_output" collides between kernel capability "final_output" and subagent source "subagents/final_output"',
    );
  });

  it("assigns the final diagnostics aggregate to every node independent of sibling order", async () => {
    mocks.compileAgentConfig.mockImplementation(async (manifest: AgentSourceManifest) =>
      createConfig({
        description: manifest.agentId === "root" ? undefined : `${manifest.agentId} subagent`,
        name: manifest.agentId,
      }),
    );
    mocks.applicationDefinition.mockImplementation(
      async (input: { source: { logicalPath: string } }) => {
        if (input.source.logicalPath.startsWith("channels/")) {
          return defineChannel({
            routes: [GET("/diagnostics-order", async () => new Response("ok"))],
          });
        }
        return { description: "Subagent", model: "openai/gpt-5.5" };
      },
    );

    const compileInOrder = async (subagentIds: readonly string[]) => {
      const diagnostics: NonNullable<Parameters<typeof compileAgentManifest>[1]>["diagnostics"] =
        [];
      const compiled = await compileAgentManifest(createDiagnosticsOrderManifest(subagentIds), {
        diagnostics,
      });

      return {
        diagnostics,
        summaries: [
          compiled.diagnosticsSummary,
          ...compiled.subagents.map((subagent) => subagent.agent.diagnosticsSummary),
        ],
      };
    };

    const first = await compileInOrder(["quiet", "warning"]);
    const second = await compileInOrder(["warning", "quiet"]);

    for (const result of [first, second]) {
      expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
        "compile/channel-route-shadowed",
      ]);
      expect(result.summaries).toEqual([
        { errors: 0, warnings: 1 },
        { errors: 0, warnings: 1 },
        { errors: 0, warnings: 1 },
      ]);
    }
  });

  it("keeps application and extension dependency declarations owner-scoped", async () => {
    const packageRoot = process.cwd();
    const extensionManifest = createAgentSourceManifest({
      agentId: "research-extension",
      agentRoot: `${packageRoot}/extension`,
      appRoot: packageRoot,
    });
    const manifest = createAgentSourceManifest({
      agentId: "root",
      agentRoot: `${packageRoot}/agent`,
      appRoot: packageRoot,
      extensions: [createModuleSourceRef({ logicalPath: "extensions/research.ts" })],
      resolvedExtensions: [
        {
          namespace: "research",
          specifier: "@acme/research",
          packageName: "@acme/research",
          packageRoot,
          sourceRoot: packageRoot,
          manifest: extensionManifest,
          externalDependencies: ["emulate", "zod"],
        },
      ],
    });
    mocks.compileAgentConfig.mockResolvedValue(
      createConfig({
        name: "root",
        build: { externalDependencies: ["zod"] },
      }),
    );

    const compiled = await compileAgentManifest(manifest);

    expect(compiled.config.build?.externalDependencies).toEqual(["zod"]);
    expect(compiled.extensionMounts).toEqual([
      expect.objectContaining({
        namespace: "research",
        externalDependencies: ["emulate", "zod"],
      }),
    ]);
    expect(compiled.externalDependencyPlan.entries.map((entry) => entry.id)).toEqual([
      "emulate",
      "zod",
    ]);
    expect(
      compiled.externalDependencyPlan.entries.find((entry) => entry.id === "zod")?.scopes,
    ).toEqual([
      expect.objectContaining({ kind: "application" }),
      expect.objectContaining({ kind: "extension", namespace: "research" }),
    ]);
  });

  it("rejects a filesystem binding that borrows a sibling node dependency", async () => {
    const appRoot = process.cwd();
    const createSubagent = (name: string) => {
      const subagentManifest = createAgentSourceManifest({
        agentId: name,
        agentRoot: `${appRoot}/agent/subagents/${name}`,
        appRoot,
        configModule: createModuleSourceRef({ logicalPath: "agent.ts" }),
      });
      return createLocalSubagentSourceRef({
        entryPath: `${appRoot}/agent/subagents/${name}/agent.ts`,
        logicalPath: `subagents/${name}`,
        manifest: subagentManifest,
        rootPath: `${appRoot}/agent/subagents/${name}`,
        subagentId: name,
      });
    };
    const manifest = createAgentSourceManifest({
      agentId: "root",
      agentRoot: `${appRoot}/agent`,
      appRoot,
      subagents: [createSubagent("borrower"), createSubagent("declarer")],
    });
    mocks.compileAgentConfig.mockImplementation(async (input: AgentSourceManifest) => {
      const config: Parameters<typeof createConfig>[0] = { name: input.agentId };
      if (input.agentId === "declarer") {
        config.build = { externalDependencies: ["zod"] };
      }
      if (input.agentId !== "root") {
        config.description = `${input.agentId} handles delegated requests.`;
      }
      return createConfig(config);
    });
    mocks.applicationDefinition.mockResolvedValue(
      defineAgent({
        description: "Handles delegated requests.",
        model: "openai/gpt-5.5",
      }),
    );

    const compiled = await compileAgentManifest(manifest);
    const borrower = compiled.subagents.find((subagent) => subagent.name === "borrower")!;
    if (borrower.configResolver !== undefined) throw new Error("Expected a static subagent.");
    const sourceId = borrower.agent.config.source.sourceId;
    const binding = borrower.agent.bindings[sourceId]!;
    if (binding.backing.kind !== "filesystem") throw new Error("Expected filesystem backing.");
    const malformedBorrower = {
      ...borrower,
      agent: {
        ...borrower.agent,
        bindings: {
          ...borrower.agent.bindings,
          [sourceId]: {
            ...binding,
            backing: { ...binding.backing, externalDependencies: ["zod"] },
          },
        },
      },
    };
    const malformed = {
      ...compiled,
      subagents: compiled.subagents.map((subagent) =>
        subagent.nodeId === borrower.nodeId ? malformedBorrower : subagent,
      ),
    };

    expect(() => assertCompiledAgentManifestSemantics(malformed)).toThrow(
      `Compiled node "${borrower.nodeId}" binding "${sourceId}" claims external dependency "zod" outside its inherited, configured, or exact extension-mount scope.`,
    );
  });

  it("rejects an extension binding that borrows another mount's dependency", async () => {
    const packageRoot = process.cwd();
    const createExtensionManifest = (name: string) =>
      createAgentSourceManifest({
        agentId: `${name}-extension`,
        agentRoot: `${packageRoot}/extensions/${name}`,
        appRoot: packageRoot,
        tools: [createModuleSourceRef({ logicalPath: "tools/search.ts" })],
      });
    const manifest = createAgentSourceManifest({
      agentId: "root",
      agentRoot: `${packageRoot}/agent`,
      appRoot: packageRoot,
      extensions: [
        createModuleSourceRef({ logicalPath: "extensions/alpha.ts" }),
        createModuleSourceRef({ logicalPath: "extensions/beta.ts" }),
      ],
      resolvedExtensions: [
        {
          externalDependencies: ["zod"],
          manifest: createExtensionManifest("alpha"),
          namespace: "alpha",
          packageName: "@acme/alpha",
          packageRoot,
          sourceRoot: packageRoot,
          specifier: "@acme/alpha",
        },
        {
          externalDependencies: ["emulate"],
          manifest: createExtensionManifest("beta"),
          namespace: "beta",
          packageName: "@acme/beta",
          packageRoot,
          sourceRoot: packageRoot,
          specifier: "@acme/beta",
        },
      ],
    });
    mocks.compileAgentConfig.mockResolvedValue(createConfig({ name: "root" }));
    mocks.applicationDefinition.mockResolvedValue(
      defineTool({
        description: "Searches records.",
        execute: async () => null,
        inputSchema: z.object({}),
      }),
    );

    const compiled = await compileAgentManifest(manifest);
    const betaEntry = Object.entries(compiled.bindings).find(
      ([, binding]) => binding.owner.kind === "extension" && binding.owner.namespace === "beta",
    );
    if (betaEntry === undefined) throw new Error("Expected the beta extension binding.");
    const [sourceId, binding] = betaEntry;
    if (binding.backing.kind !== "filesystem") throw new Error("Expected filesystem backing.");
    const malformed = {
      ...compiled,
      bindings: {
        ...compiled.bindings,
        [sourceId]: {
          ...binding,
          backing: {
            ...binding.backing,
            externalDependencies: [...binding.backing.externalDependencies, "zod"],
          },
        },
      },
    };

    expect(() => assertCompiledAgentManifestSemantics(malformed)).toThrow(
      `Compiled node "__root__" binding "${sourceId}" claims external dependency "zod" outside its inherited, configured, or exact extension-mount scope.`,
    );
  });

  it("retains extension mounts on the subagent that owns them", async () => {
    const extensionManifest = createAgentSourceManifest({
      agentId: "research-extension",
      agentRoot: "/packages/research/dist/extension",
      appRoot: "/packages/research",
    });
    const mountRef = createModuleSourceRef({ logicalPath: "extensions/research.ts" });
    const subagentManifest = createAgentSourceManifest({
      agentId: "researcher",
      agentRoot: "/app/agent/subagents/researcher",
      appRoot: "/app",
      configModule: createModuleSourceRef({ logicalPath: "agent.ts" }),
      extensions: [mountRef],
      resolvedExtensions: [
        {
          namespace: "research",
          specifier: "@acme/research",
          packageName: "@acme/research",
          packageRoot: "/packages/research",
          sourceRoot: "/packages/research/dist/extension",
          manifest: extensionManifest,
          externalDependencies: [],
        },
      ],
    });
    const manifest = createAgentSourceManifest({
      agentId: "root",
      agentRoot: "/app/agent",
      appRoot: "/app",
      subagents: [
        createLocalSubagentSourceRef({
          entryPath: "subagents/researcher/agent.ts",
          logicalPath: "subagents/researcher",
          manifest: subagentManifest,
          rootPath: "/app/agent/subagents/researcher",
          subagentId: "researcher",
        }),
      ],
    });
    mocks.compileAgentConfig.mockImplementation(async (input: AgentSourceManifest) =>
      input.agentId === "researcher"
        ? createConfig({ name: input.agentId, description: "Research the request." })
        : createConfig({ name: input.agentId }),
    );
    mocks.applicationDefinition.mockResolvedValue({
      description: "Research the request.",
      model: "openai/gpt-5.5",
    });

    const compiled = await compileAgentManifest(manifest);

    expect(compiled.extensionMounts).toEqual([]);
    expect(compiled.subagents[0]?.agent.extensionMounts).toEqual([
      expect.objectContaining({
        namespace: "research",
        mountLogicalPath: "extensions/research.ts",
        packageName: "@acme/research",
      }),
    ]);
    expect(collectModuleRefsForManifest(compiled.subagents[0]!.agent)).toContainEqual({
      sourceKind: "module",
      logicalPath: "extensions/research.ts",
      sourceId: "extensions/research.ts",
    });
  });

  it("rejects background-task configuration on subagents", async () => {
    const subagentManifest = createAgentSourceManifest({
      agentId: "research",
      agentRoot: "/app/agent/subagents/research",
      appRoot: "/app",
      configModule: createModuleSourceRef({
        logicalPath: "agent.ts",
      }),
    });
    const manifest = createAgentSourceManifest({
      agentId: "root",
      agentRoot: "/app/agent",
      appRoot: "/app",
      subagents: [
        createLocalSubagentSourceRef({
          entryPath: "subagents/research/agent.ts",
          logicalPath: "subagents/research",
          manifest: subagentManifest,
          rootPath: "/app/agent/subagents/research",
          subagentId: "research",
        }),
      ],
    });

    mocks.compileAgentConfig.mockImplementation(async (input: AgentSourceManifest) => {
      if (input.agentId === "research") {
        return createConfig({
          description: "Research subagent",
          name: "research",
          experimental: {
            tasks: true,
          },
        });
      }

      return createConfig({ name: "root" });
    });
    mocks.applicationDefinition.mockResolvedValue({
      description: "Research subagent",
      model: "openai/gpt-5.5",
    });

    await expect(compileAgentManifest(manifest)).rejects.toThrow(
      'Remove "experimental.tasks" from "research"',
    );
  });

  it("requires experimental.tasks for background tools", async () => {
    const manifest = createAgentSourceManifest({
      agentId: "root",
      agentRoot: "/app/agent",
      appRoot: "/app",
      tools: [createModuleSourceRef({ logicalPath: "tools/export.ts" })],
    });
    mocks.applicationDefinition.mockResolvedValue(
      defineTool({
        description: "Starts an export.",
        execution: "background",
        inputSchema: z.object({}),
        execute: () => ({ ok: true }),
      }),
    );
    mocks.compileAgentConfig.mockResolvedValue(createConfig({ name: "root" }));

    await expect(compileAgentManifest(manifest)).rejects.toThrow(
      'Background tool "export" requires experimental.tasks: true in the root agent config.',
    );

    mocks.compileAgentConfig.mockResolvedValue(
      createConfig({ experimental: { tasks: true }, name: "root" }),
    );
    const compiled = await compileAgentManifest(manifest);
    expect(compiled.tools).toContainEqual(
      expect.objectContaining({ execution: "background", name: "export" }),
    );
  });

  it("compiles experimental Workflow tool configuration", async () => {
    const manifest = createAgentSourceManifest({
      agentId: "root",
      agentRoot: "/app/agent",
      appRoot: "/app",
      tools: [createModuleSourceRef({ logicalPath: "tools/workflow.ts" })],
    });
    mocks.compileAgentConfig.mockResolvedValue(createConfig({ name: "root" }));
    mocks.applicationDefinition.mockResolvedValue(experimental_workflow({ maxSubagents: 6 }));

    const compiled = await compileAgentManifest(manifest);

    expect(compiled.workflowTool).toEqual({
      exportName: undefined,
      logicalPath: "tools/workflow.ts",
      maxSubagents: 6,
      sourceId: "tools/workflow.ts",
      sourceKind: "module",
    });
    expect(compiled.kernelPlan.prepared).toContain("Workflow");
  });

  it("compiles web search provider configuration", async () => {
    const manifest = createAgentSourceManifest({
      agentId: "root",
      agentRoot: "/app/agent",
      appRoot: "/app",
      tools: [createModuleSourceRef({ logicalPath: "tools/web_search.ts" })],
    });
    mocks.compileAgentConfig.mockResolvedValue(createConfig({ name: "root" }));
    mocks.applicationDefinition.mockResolvedValue(webSearch({ provider: "parallel" }));

    const compiled = await compileAgentManifest(manifest);

    expect(compiled.webSearchProvider).toEqual({
      exportName: undefined,
      logicalPath: "tools/web_search.ts",
      provider: "parallel",
      sourceId: "tools/web_search.ts",
      sourceKind: "module",
    });
    expect(compiled.tools.map((tool) => tool.name)).toEqual([
      "bash",
      "load_skill",
      "read_file",
      "todo",
      "web_fetch",
      "write_file",
    ]);
    expect(compiled.dynamicTools).toContainEqual(
      expect.objectContaining({
        logicalPath: "tools/connection_search.ts",
        slug: "connection_search",
        sourceId: "eve.framework-defaults:tools/connection_search.ts",
      }),
    );
  });

  it("lets an application tool replace the default web search sentinel", async () => {
    mocks.compileAgentConfig.mockResolvedValue(createConfig({ name: "root" }));
    mocks.applicationDefinition.mockResolvedValue(
      defineTool({
        description: "Search an application index",
        inputSchema: z.object({ query: z.string() }),
        execute: () => [],
      }),
    );

    const compiled = await compileAgentManifest(
      createAgentSourceManifest({
        agentId: "root",
        agentRoot: "/app/agent",
        appRoot: "/app",
        tools: [createModuleSourceRef({ logicalPath: "tools/web_search.ts" })],
      }),
    );

    expect(compiled.webSearchProvider).toBeUndefined();
    expect(compiled.tools).toContainEqual(
      expect.objectContaining({
        description: "Search an application index",
        name: "web_search",
        sourceId: "tools/web_search.ts",
      }),
    );
    expect(compiled.bindings["eve.framework-defaults:tools/web_search.ts"]).toBeUndefined();
  });

  it("rejects authored tools in the reserved final_output kernel slot", async () => {
    mocks.compileAgentConfig.mockResolvedValue(createConfig({ name: "root" }));
    mocks.applicationDefinition.mockResolvedValue(
      defineTool({
        description: "Return structured data",
        execute: () => ({ ok: true }),
        inputSchema: z.object({}),
      }),
    );

    await expect(
      compileAgentManifest(
        createAgentSourceManifest({
          agentId: "root",
          agentRoot: "/app/agent",
          appRoot: "/app",
          tools: [createModuleSourceRef({ logicalPath: "tools/final_output.ts" })],
        }),
      ),
    ).rejects.toThrow("reserved final_output kernel slot");
  });

  it("compiles framework defaults through ordinary module bindings", async () => {
    mocks.compileAgentConfig.mockResolvedValue(createConfig({ name: "root" }));

    const compiled = await compileAgentManifest(
      createAgentSourceManifest({
        agentId: "root",
        agentRoot: "/app/agent",
        appRoot: "/app",
      }),
    );

    expect(compiled.tools.map((tool) => tool.name)).toEqual([
      "bash",
      "load_skill",
      "read_file",
      "todo",
      "web_fetch",
      "write_file",
    ]);
    expect(compiled.webSearchProvider).toEqual({
      exportName: undefined,
      logicalPath: "tools/web_search.ts",
      provider: "exa",
      sourceId: "eve.framework-defaults:tools/web_search.ts",
      sourceKind: "module",
    });
    expect(compiled.kernelPlan.prepared).toEqual([
      "agent",
      "ask_question",
      "web_search",
      "final_output",
    ]);
    expect(compiled.channelRoutes.effective).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          adapterKind: "http",
          logicalPath: "channels/eve.ts",
          name: "eve",
          sourceId: "eve.framework-root:channels/eve.ts",
        }),
        expect.objectContaining({
          adapterKind: "http",
          logicalPath: "channels/eve/v1/connections/callback/get.ts",
          method: "GET",
          name: "eve/v1/connections/callback/get",
          sourceId: "eve.framework-root:channels/eve/v1/connections/callback/get.ts",
        }),
        expect.objectContaining({
          adapterKind: "http",
          logicalPath: "channels/eve/v1/task-input/post.ts",
          method: "POST",
          name: "eve/v1/task-input/post",
          sourceId: "eve.framework-root:channels/eve/v1/task-input/post.ts",
        }),
      ]),
    );
    expect(compiled.sandbox).toMatchObject({
      logicalPath: "sandbox.ts",
      sourceId: "eve.framework-defaults:sandbox.ts",
    });
    expect(Object.values(compiled.bindings)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          backing: expect.objectContaining({
            kind: "programmatic",
            registryId: "eve.framework-defaults",
            semanticRevision: "eve:default-sandbox:v1",
          }),
          owner: { feature: "eve.framework-defaults", kind: "framework" },
        }),
      ]),
    );
  });

  it("lets application tools replace framework defaults by logical path", async () => {
    mocks.compileAgentConfig.mockResolvedValue(createConfig({ name: "root" }));
    mocks.applicationDefinition.mockResolvedValue(
      defineTool({
        description: "Application bash",
        inputSchema: z.object({}),
        execute: () => ({ ok: true }),
      }),
    );

    const compiled = await compileAgentManifest(
      createAgentSourceManifest({
        agentId: "root",
        agentRoot: "/app/agent",
        appRoot: "/app",
        tools: [createModuleSourceRef({ logicalPath: "tools/bash.ts" })],
      }),
    );

    expect(compiled.tools.find((tool) => tool.name === "bash")?.description).toBe(
      "Application bash",
    );
    expect(compiled.bindings["tools/bash.ts"]?.backing.kind).toBe("filesystem");
    expect(compiled.bindings["eve.framework-defaults:tools/bash.ts"]).toBeUndefined();
  });

  it("lets an application tool replace the framework connection search resolver", async () => {
    mocks.compileAgentConfig.mockResolvedValue(createConfig({ name: "root" }));
    mocks.applicationDefinition.mockResolvedValue(
      defineTool({
        description: "Search a fixed connection index",
        inputSchema: z.object({}),
        execute: () => [],
      }),
    );

    const compiled = await compileAgentManifest(
      createAgentSourceManifest({
        agentId: "root",
        agentRoot: "/app/agent",
        appRoot: "/app",
        tools: [createModuleSourceRef({ logicalPath: "tools/connection_search.ts" })],
      }),
    );

    expect(compiled.tools).toContainEqual(
      expect.objectContaining({
        name: "connection_search",
        sourceId: "tools/connection_search.ts",
      }),
    );
    expect(compiled.dynamicTools).not.toContainEqual(
      expect.objectContaining({ slug: "connection_search" }),
    );
    expect(compiled.bindings["eve.framework-defaults:tools/connection_search.ts"]).toBeUndefined();
  });

  it("preserves ordered static instruction content, roles, and legacy definitions", async () => {
    const manifest = createAgentSourceManifest({
      agentId: "root",
      agentRoot: "/app/agent",
      appRoot: "/app",
      instructions: [
        createModuleSourceRef({ logicalPath: "instructions/10-user.ts" }),
        createModuleSourceRef({ logicalPath: "instructions/20-legacy.ts" }),
      ],
    });
    mocks.compileAgentConfig.mockResolvedValue(createConfig({ name: "root" }));
    mocks.applicationDefinition
      .mockResolvedValueOnce(defineInstructions({ content: "Account context.", role: "user" }))
      .mockResolvedValueOnce(defineInstructions({ markdown: "Legacy system context." }));

    const compiled = await compileAgentManifest(manifest);

    expect(compiled.instructions).toEqual([
      expect.objectContaining({
        content: "Account context.",
        logicalPath: "instructions/10-user.ts",
        role: "user",
      }),
      expect.objectContaining({
        content: "Legacy system context.",
        logicalPath: "instructions/20-legacy.ts",
        role: "system",
      }),
    ]);
  });

  it("preserves extension-qualified names and physical skill package paths", async () => {
    const extensionManifest = createAgentSourceManifest({
      agentId: "crm-extension",
      agentRoot: "/packages/crm/agent",
      appRoot: "/packages/crm",
      instructions: [
        {
          definition: defineInstructions({ content: "Use CRM context." }),
          logicalPath: "instructions.md",
          sourceId: "instructions-opaque",
          sourceKind: "markdown",
        },
      ],
      skills: [
        createSkillPackageSourceRef({
          description: "Review CRM records.",
          logicalPath: "skills/review",
          markdown: "# Review",
          name: "review",
          rootPath: "/packages/crm/agent/skills/review",
          skillFilePath: "/packages/crm/agent/skills/review/SKILL.md",
          skillId: "review",
          sourceId: "skill-opaque",
        }),
      ],
    });
    const manifest = createAgentSourceManifest({
      agentId: "root",
      agentRoot: "/app/agent",
      appRoot: "/app",
      extensions: [createModuleSourceRef({ logicalPath: "extensions/crm.ts" })],
      resolvedExtensions: [
        {
          externalDependencies: [],
          manifest: extensionManifest,
          namespace: "crm",
          packageName: "@acme/crm",
          packageRoot: "/packages/crm",
          sourceRoot: "/packages/crm/agent",
          specifier: "@acme/crm",
        },
      ],
    });
    mocks.compileAgentConfig.mockResolvedValue(createConfig({ name: "root" }));

    const compiled = await compileAgentManifest(manifest);

    expect(compiled.instructions).toEqual([
      expect.objectContaining({
        logicalPath: "instructions/crm__instructions.md",
        name: "crm__instructions",
      }),
    ]);
    expect(compiled.skills).toEqual([
      expect.objectContaining({
        logicalPath: "skills/crm__review",
        name: "crm__review",
        rootPath: "/packages/crm/agent/skills/review",
        skillFilePath: "/packages/crm/agent/skills/review/SKILL.md",
      }),
    ]);
  });

  it("persists exact extension ownership through nested duplicate mounts", async () => {
    const nestedExtensionManifest = createAgentSourceManifest({
      agentId: "nested-extension",
      agentRoot: "/packages/nested/agent",
      appRoot: "/packages/nested",
    });
    const reviewerManifest = createAgentSourceManifest({
      agentId: "reviewer",
      agentRoot: "/packages/shared/agent/subagents/worker/subagents/reviewer",
      appRoot: "/packages/shared",
      configModule: createModuleSourceRef({ logicalPath: "agent.ts", sourceId: "reviewer-config" }),
    });
    const workerManifest = createAgentSourceManifest({
      agentId: "worker",
      agentRoot: "/packages/shared/agent/subagents/worker",
      appRoot: "/packages/shared",
      configModule: createModuleSourceRef({ logicalPath: "agent.ts", sourceId: "worker-config" }),
      extensions: [createModuleSourceRef({ logicalPath: "extensions/nested.ts" })],
      resolvedExtensions: [
        {
          externalDependencies: [],
          manifest: nestedExtensionManifest,
          namespace: "nested",
          packageName: "@acme/nested",
          packageRoot: "/packages/nested",
          sourceRoot: "/packages/nested/agent",
          specifier: "@acme/nested",
        },
      ],
      subagents: [
        createLocalSubagentSourceRef({
          entryPath: "/packages/shared/agent/subagents/worker/subagents/reviewer/agent.ts",
          logicalPath: "subagents/reviewer",
          manifest: reviewerManifest,
          rootPath: "/packages/shared/agent/subagents/worker/subagents/reviewer",
          sourceId: "reviewer-source",
          subagentId: "reviewer",
        }),
      ],
    });
    const extensionManifest = createAgentSourceManifest({
      agentId: "shared-extension",
      agentRoot: "/packages/shared/agent",
      appRoot: "/packages/shared",
      subagents: [
        createLocalSubagentSourceRef({
          entryPath: "/packages/shared/agent/subagents/worker/agent.ts",
          logicalPath: "subagents/worker",
          manifest: workerManifest,
          rootPath: "/packages/shared/agent/subagents/worker",
          sourceId: "worker-source",
          subagentId: "worker",
        }),
      ],
    });
    const mount = (namespace: string) => ({
      externalDependencies: [] as string[],
      manifest: extensionManifest,
      namespace,
      packageName: "@acme/shared",
      packageRoot: "/packages/shared",
      sourceRoot: "/packages/shared/agent",
      specifier: "@acme/shared",
    });
    const manifest = createAgentSourceManifest({
      agentId: "root",
      agentRoot: "/app/agent",
      appRoot: "/app",
      extensions: [
        createModuleSourceRef({ logicalPath: "extensions/alpha.ts" }),
        createModuleSourceRef({ logicalPath: "extensions/beta.ts" }),
      ],
      resolvedExtensions: [mount("alpha"), mount("beta")],
    });
    mocks.compileAgentConfig.mockImplementation(async (input: AgentSourceManifest) =>
      input.agentId === "root"
        ? createConfig({ name: "root" })
        : createConfig({ description: `${input.agentId} description`, name: input.agentId }),
    );
    mocks.applicationDefinition.mockResolvedValue({
      description: "extension subagent",
      model: "openai/gpt-5.5",
    });

    const compiled = await compileAgentManifest(manifest);
    const alphaNodes = compiled.subagents.filter(
      (node) => node.owner.kind === "extension" && node.owner.namespace === "alpha",
    );
    const betaNodes = compiled.subagents.filter(
      (node) => node.owner.kind === "extension" && node.owner.namespace === "beta",
    );

    expect(alphaNodes.map((node) => node.name)).toEqual(["alpha__worker", "reviewer"]);
    expect(betaNodes.map((node) => node.name)).toEqual(["beta__worker", "reviewer"]);
    expect([...alphaNodes, ...betaNodes]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          backing: expect.objectContaining({
            extensionScope: expect.objectContaining({ sourceRoot: "/packages/shared/agent" }),
            kind: "filesystem",
          }),
          owner: expect.objectContaining({ kind: "extension", packageName: "@acme/shared" }),
        }),
      ]),
    );
    expect(alphaNodes[0]?.agent.sourceComposition).not.toBe(betaNodes[0]?.agent.sourceComposition);
    const alphaWorker = alphaNodes[0]!;
    if (alphaWorker.backing.kind !== "filesystem") {
      throw new Error("Expected an extension-contributed filesystem subagent.");
    }
    expect(alphaWorker.entryPath).toBe(alphaWorker.backing.sourcePath);
    expect(alphaWorker.agent.extensionMounts).toEqual([
      expect.objectContaining({
        mountLogicalPath: "extensions/nested.ts",
        namespace: "nested",
        packageName: "@acme/nested",
      }),
    ]);
    const nestedMount = alphaWorker.agent.extensionMounts[0]!;
    expect(alphaWorker.agent.bindings[nestedMount.mountSourceId]?.owner).toEqual({
      kind: "extension",
      namespace: "alpha",
      packageName: "@acme/shared",
    });
    expect(alphaNodes[0]?.agent.sourceComposition.selected).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ slot: "agent", sourceKind: "module" }),
        expect.objectContaining({
          slot: "subagents/reviewer",
          source: expect.objectContaining({
            owner: expect.objectContaining({ kind: "extension", namespace: "alpha" }),
            sourceKind: "subagent",
          }),
        }),
      ]),
    );
    expect(() => parseCompiledAgentManifest(compiled)).not.toThrow();
  });

  it("rejects unsupported dynamic instruction event keys", async () => {
    const manifest = createAgentSourceManifest({
      agentId: "root",
      agentRoot: "/app/agent",
      appRoot: "/app",
      instructions: [createModuleSourceRef({ logicalPath: "instructions/dynamic.ts" })],
    });
    mocks.compileAgentConfig.mockResolvedValue(createConfig({ name: "root" }));
    mocks.applicationDefinition.mockResolvedValue(
      defineDynamic({
        events: {
          "step.started": () => defineInstructions({ content: "Too late." }),
        },
      }),
    );

    await expect(compileAgentManifest(manifest)).rejects.toThrow(
      'Unsupported event: "step.started"',
    );
  });

  it("requires web search configuration to use the web_search filename", async () => {
    const manifest = createAgentSourceManifest({
      agentId: "root",
      agentRoot: "/app/agent",
      appRoot: "/app",
      tools: [createModuleSourceRef({ logicalPath: "tools/search.ts" })],
    });
    mocks.compileAgentConfig.mockResolvedValue(createConfig({ name: "root" }));
    mocks.applicationDefinition.mockResolvedValue(webSearch({ provider: "exa" }));

    await expect(compileAgentManifest(manifest)).rejects.toThrow(
      'must be exported from "tools/web_search.ts"',
    );
  });

  it("lets a canonical dynamic tool replace its native capability", async () => {
    const manifest = createAgentSourceManifest({
      agentId: "root",
      agentRoot: "/app/agent",
      appRoot: "/app",
      tools: [createModuleSourceRef({ logicalPath: "tools/ask_question.ts" })],
    });
    mocks.compileAgentConfig.mockResolvedValue(createConfig({ name: "root" }));
    mocks.applicationDefinition.mockResolvedValue(
      defineDynamic({ events: { "session.started": () => null } }),
    );

    const compiled = await compileAgentManifest(manifest);

    expect(compiled.dynamicTools).toContainEqual(
      expect.objectContaining({ logicalPath: "tools/ask_question.ts", slug: "ask_question" }),
    );
    expect(compiled.kernelPlan.prepared).not.toContain("ask_question");
  });

  it("compiles a dynamic subagent manifest without resolving an agent config", async () => {
    const dynamic = defineDynamic({
      events: {
        "session.started": () =>
          defineAgent({
            description: "Research the request.",
            model: "openai/gpt-5.5",
          }),
        "turn.started": () => null,
      },
    });
    const manifest = createManifestWithSubagent();
    mocks.compileAgentConfig.mockImplementation(async (input: AgentSourceManifest) =>
      createConfig({ name: input.agentId }),
    );
    mocks.applicationDefinition.mockResolvedValue(dynamic);

    const compiled = await compileAgentManifest(manifest);

    expect(compiled.subagents[0]?.configResolver).toMatchObject({
      eventNames: ["session.started", "turn.started"],
      logicalPath: "agent.ts",
      sourceId: "agent.ts",
      sourceKind: "module",
    });
    expect("config" in compiled.subagents[0]!.agent).toBe(false);
    expect(compiled.subagents[0]?.description).toBeUndefined();
    expect(mocks.compileAgentConfig).toHaveBeenCalledTimes(1);
  });

  it("binds an application dynamic subagent config with its evaluated dependencies", async () => {
    const dynamic = defineDynamic({
      build: { externalDependencies: ["zod"] },
      events: {
        "session.started": () =>
          defineAgent({
            description: "Research the request.",
            model: "openai/gpt-5.5",
          }),
      },
    });
    mocks.compileAgentConfig.mockImplementation(async (input: AgentSourceManifest) =>
      createConfig({ name: input.agentId }),
    );
    mocks.applicationDefinition.mockResolvedValue(dynamic);

    const compiled = await compileAgentManifest(createManifestWithSubagent(process.cwd()));
    const dynamicNode = compiled.subagents[0]!;
    const configResolver = dynamicNode.configResolver!;

    expect(dynamicNode.agent.bindings[configResolver.sourceId]?.backing).toMatchObject({
      externalDependencies: ["zod"],
      kind: "filesystem",
    });
  });

  it("binds an extension-owned dynamic subagent config with inherited owner dependencies", async () => {
    const packageRoot = process.cwd();
    const workerManifest = createAgentSourceManifest({
      agentId: "worker",
      agentRoot: `${packageRoot}/extension/subagents/worker`,
      appRoot: packageRoot,
      configModule: createModuleSourceRef({ logicalPath: "agent.ts" }),
    });
    const extensionManifest = createAgentSourceManifest({
      agentId: "research-extension",
      agentRoot: `${packageRoot}/extension`,
      appRoot: packageRoot,
      subagents: [
        createLocalSubagentSourceRef({
          entryPath: `${packageRoot}/extension/subagents/worker/agent.ts`,
          logicalPath: "subagents/worker",
          manifest: workerManifest,
          rootPath: `${packageRoot}/extension/subagents/worker`,
          subagentId: "worker",
        }),
      ],
    });
    const manifest = createAgentSourceManifest({
      agentId: "root",
      agentRoot: `${packageRoot}/agent`,
      appRoot: packageRoot,
      extensions: [createModuleSourceRef({ logicalPath: "extensions/research.ts" })],
      resolvedExtensions: [
        {
          externalDependencies: ["semver"],
          manifest: extensionManifest,
          namespace: "research",
          packageName: "@acme/research",
          packageRoot,
          sourceRoot: packageRoot,
          specifier: "@acme/research",
        },
      ],
    });
    mocks.compileAgentConfig.mockResolvedValue(
      createConfig({
        build: { externalDependencies: ["picocolors"] },
        name: "root",
      }),
    );
    mocks.applicationDefinition.mockResolvedValue(
      defineDynamic({
        build: { externalDependencies: ["eventsource-parser"] },
        events: { "session.started": () => null },
      }),
    );

    const compiled = await compileAgentManifest(manifest);
    const dynamicNode = compiled.subagents.find(
      (subagent) => subagent.name === "research__worker",
    )!;
    const configResolver = dynamicNode.configResolver!;

    expect(dynamicNode.owner).toEqual({
      kind: "extension",
      namespace: "research",
      packageName: "@acme/research",
    });
    expect(dynamicNode.agent.bindings[configResolver.sourceId]?.backing).toMatchObject({
      externalDependencies: ["picocolors", "semver", "eventsource-parser"],
      kind: "filesystem",
    });
    expect(
      compiled.externalDependencyPlan.entries.find((entry) => entry.id === "eventsource-parser")
        ?.scopes,
    ).toEqual([
      expect.objectContaining({
        kind: "extension",
        namespace: "research",
        nodeId: dynamicNode.nodeId,
      }),
    ]);
    expect(() => assertCompiledAgentManifestSemantics(compiled)).not.toThrow();
  });

  it("binds a nested dynamic subagent config with its full ancestor dependency closure", async () => {
    const appRoot = process.cwd();
    const nestedManifest = createAgentSourceManifest({
      agentId: "nested",
      agentRoot: `${appRoot}/agent/subagents/parent/subagents/nested`,
      appRoot,
      configModule: createModuleSourceRef({ logicalPath: "agent.ts" }),
    });
    const parentManifest = createAgentSourceManifest({
      agentId: "parent",
      agentRoot: `${appRoot}/agent/subagents/parent`,
      appRoot,
      configModule: createModuleSourceRef({ logicalPath: "agent.ts" }),
      subagents: [
        createLocalSubagentSourceRef({
          entryPath: `${appRoot}/agent/subagents/parent/subagents/nested/agent.ts`,
          logicalPath: "subagents/nested",
          manifest: nestedManifest,
          rootPath: `${appRoot}/agent/subagents/parent/subagents/nested`,
          subagentId: "nested",
        }),
      ],
    });
    const manifest = createAgentSourceManifest({
      agentId: "root",
      agentRoot: `${appRoot}/agent`,
      appRoot,
      subagents: [
        createLocalSubagentSourceRef({
          entryPath: `${appRoot}/agent/subagents/parent/agent.ts`,
          logicalPath: "subagents/parent",
          manifest: parentManifest,
          rootPath: `${appRoot}/agent/subagents/parent`,
          subagentId: "parent",
        }),
      ],
    });
    mocks.compileAgentConfig.mockImplementation(async (input: AgentSourceManifest) =>
      input.agentId === "root"
        ? createConfig({ build: { externalDependencies: ["picocolors"] }, name: "root" })
        : createConfig({
            build: { externalDependencies: ["semver"] },
            description: "Delegate to the nested worker.",
            name: "parent",
          }),
    );
    mocks.applicationDefinition.mockImplementation(
      async (input: { binding?: { backing: { sourcePath?: string } } }) =>
        input.binding?.backing.sourcePath ===
        `${appRoot}/agent/subagents/parent/subagents/nested/agent.ts`
          ? defineDynamic({
              build: { externalDependencies: ["eventsource-parser"] },
              events: { "session.started": () => null },
            })
          : defineAgent({
              description: "Delegate to the nested worker.",
              model: "openai/gpt-5.5",
            }),
    );

    const compiled = await compileAgentManifest(manifest);
    const dynamicNode = compiled.subagents.find((subagent) => subagent.name === "nested")!;
    const configResolver = dynamicNode.configResolver!;

    expect(dynamicNode.agent.bindings[configResolver.sourceId]?.backing).toMatchObject({
      externalDependencies: ["picocolors", "semver", "eventsource-parser"],
      kind: "filesystem",
    });
    expect(
      compiled.externalDependencyPlan.entries.find((entry) => entry.id === "eventsource-parser")
        ?.scopes,
    ).toEqual([expect.objectContaining({ kind: "application", nodeId: dynamicNode.nodeId })]);
    expect(() => assertCompiledAgentManifestSemantics(compiled)).not.toThrow();
  });

  it("keeps composed bindings isolated when a dynamic subagent shares the root directory", async () => {
    const dynamic = defineDynamic({
      events: {
        "session.started": () =>
          defineAgent({
            description: "Resolve a remote worker.",
            model: "openai/gpt-5.5",
          }),
      },
    });
    const root = createAgentSourceManifest({
      agentId: "root",
      agentRoot: "/app/agent",
      appRoot: "/app",
      subagents: [
        createLocalSubagentSourceRef({
          entryPath: "/app/agent/subagents/dynamic.ts",
          logicalPath: "subagents/dynamic.ts",
          manifest: createAgentSourceManifest({
            agentId: "dynamic",
            agentRoot: "/app/agent",
            appRoot: "/app",
            configModule: createModuleSourceRef({ logicalPath: "subagents/dynamic.ts" }),
          }),
          rootPath: "/app/agent",
          subagentId: "dynamic",
        }),
      ],
    });
    mocks.compileAgentConfig.mockResolvedValue(createConfig({ name: "root" }));
    mocks.applicationDefinition.mockResolvedValue(dynamic);

    const compiled = await compileAgentManifest(root);

    expect(
      compiled.bindings["eve.framework-root:channels/eve/v1/callback/post.ts"]?.backing.kind,
    ).toBe("programmatic");
  });

  it("preserves a remote config candidate graph as its own exact module scope", async () => {
    const manifest = createManifestWithSubagent();
    mocks.compileAgentConfig.mockResolvedValue(createConfig({ name: "root" }));
    mocks.applicationDefinition.mockResolvedValue({
      description: "Inspect a remote deployment.",
      kind: "remote",
      path: "/eve/v1/session",
      url: "https://remote.example.com",
    });

    const compiled = await compileAgentManifest(manifest);
    const remote = compiled.remoteAgents[0]!;
    const remoteScope = collectCompiledModuleScopes(compiled).find(
      (scope) => scope.nodeId === remote.nodeId,
    );

    expect(remote.configResolver).toEqual({
      exportName: undefined,
      logicalPath: "agent.ts",
      sourceId: "agent.ts",
      sourceKind: "module",
    });
    expect(remote.bindings).toEqual({
      "agent.ts": expect.objectContaining({
        logicalPath: "agent.ts",
        owner: { kind: "application" },
      }),
    });
    expect(remote.sourceComposition.selected).toEqual([
      { slot: "agent", sourceId: "agent.ts", sourceKind: "module" },
    ]);
    expect(compiled.bindings).not.toHaveProperty("agent.ts");
    expect(remoteScope).toMatchObject({
      bindings: remote.bindings,
      nodeId: remote.nodeId,
      refs: [remote.configResolver],
    });
  });

  it("rejects an empty literal remote subagent url during normalization", async () => {
    mocks.compileAgentConfig.mockResolvedValue(createConfig({ name: "root" }));
    mocks.applicationDefinition.mockResolvedValue({
      description: "Inspect a remote deployment.",
      kind: "remote",
      path: "/eve/v1/session",
      url: "",
    });

    await expect(compileAgentManifest(createManifestWithSubagent())).rejects.toThrow(
      'Expected "url" to be a non-empty string or function.',
    );
  });

  it("rejects extension mounts in a remote subagent package", async () => {
    const extensionManifest = createAgentSourceManifest({
      agentId: "nested-extension",
      agentRoot: "/packages/nested/agent",
      appRoot: "/packages/nested",
    });
    const remoteManifest = createAgentSourceManifest({
      agentId: "remote",
      agentRoot: "/app/agent/subagents/remote",
      appRoot: "/app",
      configModule: createModuleSourceRef({ logicalPath: "agent.ts" }),
      extensions: [createModuleSourceRef({ logicalPath: "extensions/nested.ts" })],
      resolvedExtensions: [
        {
          externalDependencies: [],
          manifest: extensionManifest,
          namespace: "nested",
          packageName: "@acme/nested",
          packageRoot: "/packages/nested",
          sourceRoot: "/packages/nested/agent",
          specifier: "@acme/nested",
        },
      ],
    });
    const manifest = createAgentSourceManifest({
      agentId: "root",
      agentRoot: "/app/agent",
      appRoot: "/app",
      subagents: [
        createLocalSubagentSourceRef({
          entryPath: "/app/agent/subagents/remote/agent.ts",
          logicalPath: "subagents/remote",
          manifest: remoteManifest,
          rootPath: "/app/agent/subagents/remote",
          subagentId: "remote",
        }),
      ],
    });
    mocks.compileAgentConfig.mockResolvedValue(createConfig({ name: "root" }));
    mocks.applicationDefinition.mockResolvedValue({
      description: "Inspect a remote deployment.",
      kind: "remote",
      path: "/eve/v1/session",
      url: "https://remote.example.com",
    });

    await expect(compileAgentManifest(manifest)).rejects.toThrow(
      "Remove unsupported entries: extensions/.",
    );
  });

  it("applies dynamic subagent build configuration before resolving events", async () => {
    const dynamic = defineDynamic({
      build: { externalDependencies: ["eve"] },
      events: {
        "session.started": () =>
          defineAgent({
            description: "Edit the request.",
            model: "openai/gpt-5.5",
          }),
      },
    });
    const manifest = createManifestWithSubagent();
    mocks.compileAgentConfig.mockImplementation(async (input: AgentSourceManifest) =>
      createConfig({ name: input.agentId }),
    );
    mocks.applicationDefinition.mockResolvedValue(dynamic);

    const compiled = await compileAgentManifest(manifest);

    expect(compiled.subagents[0]?.configResolver).toMatchObject({
      build: { externalDependencies: ["eve"] },
      eventNames: ["session.started"],
      logicalPath: "agent.ts",
      sourceId: "agent.ts",
      sourceKind: "module",
    });
    expect("config" in compiled.subagents[0]!.agent).toBe(false);
    expect(mocks.compileAgentConfig).toHaveBeenCalledTimes(1);
  });

  it("rejects invalid dynamic subagent build configuration", async () => {
    mocks.compileAgentConfig.mockResolvedValue(createConfig({ name: "root" }));
    mocks.applicationDefinition.mockResolvedValue({
      build: { externalDependencies: "just-bash" },
      events: { "session.started": () => null },
      kind: "eve:dynamic",
    });

    await expect(compileAgentManifest(createManifestWithSubagent())).rejects.toThrow(
      "Expected the dynamic subagent config export",
    );
  });

  it("rejects fallback on a dynamic subagent", async () => {
    mocks.compileAgentConfig.mockResolvedValue(createConfig({ name: "root" }));
    mocks.applicationDefinition.mockResolvedValue({
      ...defineDynamic({
        events: {
          "session.started": () => null,
        },
      }),
      fallback: defineAgent({
        description: "Research the request.",
        model: "openai/gpt-5.5",
      }),
    });

    await expect(compileAgentManifest(createManifestWithSubagent())).rejects.toThrow(
      'Unknown key "fallback"',
    );
  });

  it("rejects step-scoped dynamic subagents", async () => {
    mocks.compileAgentConfig.mockResolvedValue(createConfig({ name: "root" }));
    mocks.applicationDefinition.mockResolvedValue(
      defineDynamic({
        events: {
          "step.started": () =>
            defineAgent({
              description: "Research the request.",
              model: "openai/gpt-5.5",
            }),
        },
      }),
    );

    await expect(compileAgentManifest(createManifestWithSubagent())).rejects.toThrow(
      'Dynamic subagents support only "session.started" and "turn.started" handlers',
    );
  });
});

function createManifestWithSubagent(appRoot = "/app"): AgentSourceManifest {
  const subagentManifest = createAgentSourceManifest({
    agentId: "researcher",
    agentRoot: `${appRoot}/agent/subagents/researcher`,
    appRoot,
    configModule: createModuleSourceRef({ logicalPath: "agent.ts" }),
  });
  return createAgentSourceManifest({
    agentId: "root",
    agentRoot: `${appRoot}/agent`,
    appRoot,
    subagents: [
      createLocalSubagentSourceRef({
        entryPath: "subagents/researcher/agent.ts",
        logicalPath: "subagents/researcher",
        manifest: subagentManifest,
        rootPath: `${appRoot}/agent/subagents/researcher`,
        subagentId: "researcher",
      }),
    ],
  });
}

function createDiagnosticsOrderManifest(subagentIds: readonly string[]): AgentSourceManifest {
  const createSubagentManifest = (subagentId: string): AgentSourceManifest =>
    createAgentSourceManifest({
      agentId: subagentId,
      agentRoot: `/app/agent/subagents/${subagentId}`,
      appRoot: "/app",
      channels:
        subagentId === "warning"
          ? [
              createModuleSourceRef({ logicalPath: "channels/child-a.ts" }),
              createModuleSourceRef({ logicalPath: "channels/child-b.ts" }),
            ]
          : [],
      configModule: createModuleSourceRef({ logicalPath: "agent.ts" }),
    });

  return createAgentSourceManifest({
    agentId: "root",
    agentRoot: "/app/agent",
    appRoot: "/app",
    channels: [
      createModuleSourceRef({ logicalPath: "channels/root-a.ts" }),
      createModuleSourceRef({ logicalPath: "channels/root-b.ts" }),
    ],
    subagents: subagentIds.map((subagentId) =>
      createLocalSubagentSourceRef({
        entryPath: `/app/agent/subagents/${subagentId}/agent.ts`,
        logicalPath: `subagents/${subagentId}`,
        manifest: createSubagentManifest(subagentId),
        rootPath: `/app/agent/subagents/${subagentId}`,
        subagentId,
      }),
    ),
  });
}

function createConfig(
  input: Pick<CompiledAgentDefinition, "name"> &
    Partial<Pick<CompiledAgentDefinition, "build" | "description" | "experimental">>,
): CompiledAgentDefinition {
  const config: CompiledAgentDefinition = {
    model: {
      id: "openai/gpt-5.5",
      routing: classifyModelRouting("openai/gpt-5.5"),
    },
    name: input.name,
    source: {
      logicalPath: "agent.ts",
      sourceId: "test:normalized-agent-config",
      sourceKind: "module",
    },
  };

  if (input.description !== undefined) {
    config.description = input.description;
  }
  if (input.build !== undefined) {
    config.build = input.build;
  }
  if (input.experimental !== undefined) {
    config.experimental = input.experimental;
  }

  return config;
}
