import { beforeEach, describe, expect, it, vi } from "vitest";

import { z } from "#compiled/zod/index.js";
import {
  createAgentSourceManifest,
  createLocalSubagentSourceRef,
  createModuleSourceRef,
  type AgentSourceManifest,
} from "#discover/manifest.js";
import {
  createAgentSourceRegistry,
  defineProgrammaticAgentSource,
  type AgentSourceRegistry,
  type ProgrammaticAgentModule,
} from "#compiler/source-graph.js";
import { compileAgentManifest } from "#compiler/normalize-manifest.js";
import { testModelCatalogLoader } from "#internal/testing/compiled-node-fixtures.js";
import { defineAgent } from "#public/definitions/agent.js";
import { defineChannel, POST } from "#public/definitions/channel.js";
import { defineTool, disableTool, experimental_workflow } from "#public/definitions/tool.js";
import { webSearch, WEB_SEARCH_TOOL_DESCRIPTION } from "#public/tools/web-search.js";

const mocks = vi.hoisted(() => ({
  loadComposedModuleDefinition: vi.fn(),
}));

vi.mock("#compiler/normalize-helpers.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("#compiler/normalize-helpers.js")>()),
  loadComposedModuleDefinition: mocks.loadComposedModuleDefinition,
}));

const actualHelpers = await vi.importActual<typeof import("#compiler/normalize-helpers.js")>(
  "#compiler/normalize-helpers.js",
);

type LoadInput = Parameters<(typeof actualHelpers)["loadComposedModuleDefinition"]>[0];

/**
 * Routes filesystem-backed loads (subagent configs discovered on disk) to
 * the provided definition while programmatic sources — framework defaults
 * and in-memory application sources — load through the real registry path.
 */
function loadFilesystemBackingsAs(definition: unknown): void {
  mocks.loadComposedModuleDefinition.mockImplementation(async (input: LoadInput) => {
    if (input.backing?.kind === "programmatic") {
      return await actualHelpers.loadComposedModuleDefinition(input);
    }
    return definition;
  });
}

function createApplicationRegistry(
  modules: readonly ProgrammaticAgentModule[],
): AgentSourceRegistry {
  return createAgentSourceRegistry(
    [
      {
        applyTo: "root",
        source: defineProgrammaticAgentSource({ id: "test-app", modules, revision: "r1" }),
      },
    ],
    { allowFrameworkSlots: true },
  );
}

function createRootManifest(
  overrides: Partial<Parameters<typeof createAgentSourceManifest>[0]> = {},
): AgentSourceManifest {
  return createAgentSourceManifest({
    agentId: "root",
    agentRoot: "/app/agent",
    appRoot: "/app",
    ...overrides,
  });
}

async function compile(
  manifest: AgentSourceManifest,
  options: { applicationRegistry?: AgentSourceRegistry } = {},
) {
  return await compileAgentManifest(manifest, {
    modelCatalog: testModelCatalogLoader(),
    ...options,
  });
}

describe("compileAgentManifest", () => {
  beforeEach(() => {
    mocks.loadComposedModuleDefinition.mockReset();
    mocks.loadComposedModuleDefinition.mockImplementation(
      actualHelpers.loadComposedModuleDefinition,
    );
  });

  it("compiles framework defaults with framework-owned bindings into an empty root node", async () => {
    const compiled = await compile(createRootManifest());

    expect(compiled.tools.map((tool) => tool.name).sort()).toEqual([
      "agent",
      "ask_question",
      "bash",
      "load_skill",
      "read_file",
      "task_cancel",
      "task_update",
      "todo",
      "web_fetch",
      "web_search",
      "write_file",
    ]);
    expect(compiled.dynamicTools).toEqual([
      expect.objectContaining({
        slug: "connection_search",
        sourceId: "eve:tools/connection_search.ts",
      }),
    ]);
    expect(compiled.sandbox.sourceId).toBe("eve:sandbox.ts");
    expect(compiled.config.model?.id).toBe("zai/glm-5.2");
    expect(compiled.config.source?.sourceId).toBe("eve:agent.ts");
    expect(compiled.bindings["eve:tools/bash.ts"]).toMatchObject({
      backing: { kind: "programmatic", moduleId: "tools/bash.ts", registryId: "eve" },
      logicalPath: "tools/bash.ts",
      owner: { feature: "tools/bash", kind: "framework" },
    });
    expect(compiled.bindings["eve-root:tools/agent.ts"]).toMatchObject({
      owner: { kind: "framework" },
    });
    expect(compiled.sourceComposition).toEqual({ disabled: [], shadowed: [] });
  });

  it("plans channel routes from the framework eve and home channels plus authored channels", async () => {
    const applicationRegistry = createApplicationRegistry([
      {
        logicalPath: "channels/support.ts",
        loadNamespace: async () => ({
          default: defineChannel({
            routes: [POST("/support", async () => new Response("ok"))],
          }),
        }),
      },
    ]);

    const compiled = await compile(createRootManifest(), { applicationRegistry });

    expect(compiled.channelRoutes.effective).toContainEqual(
      expect.objectContaining({
        method: "GET",
        sourceId: "eve-root:channels/home.ts",
        urlPath: "/",
      }),
    );
    expect(compiled.channelRoutes.effective).toContainEqual(
      expect.objectContaining({
        method: "HEAD",
        sourceId: "eve-root:channels/home.ts",
        urlPath: "/",
      }),
    );
    expect(compiled.channelRoutes.effective).toContainEqual(
      expect.objectContaining({
        method: "POST",
        sourceId: "eve-root:channels/eve.ts",
        urlPath: "/eve/v1/session",
      }),
    );
    expect(compiled.channelRoutes.effective).toContainEqual(
      expect.objectContaining({
        method: "GET",
        sourceId: "eve-root:channels/eve.ts",
        urlPath: "/eve/v1/health",
      }),
    );
    expect(compiled.channelRoutes.effective).toContainEqual(
      expect.objectContaining({
        method: "POST",
        name: "support",
        sourceId: "test-app:channels/support.ts",
        urlPath: "/support",
      }),
    );
    expect(compiled.channelRoutes.preflight).toEqual([]);
    expect(compiled.channelRoutes.shadowed).toEqual([]);
  });

  it("replaces a framework tool with an authored tool and records the shadowed loser", async () => {
    const applicationRegistry = createApplicationRegistry([
      {
        logicalPath: "tools/bash.ts",
        loadNamespace: async () => ({
          default: defineTool({
            description: "Custom bash.",
            inputSchema: z.object({}),
            execute: () => ({ ok: true }),
          }),
        }),
      },
    ]);

    const compiled = await compile(createRootManifest(), { applicationRegistry });

    const bashTools = compiled.tools.filter((tool) => tool.name === "bash");
    expect(bashTools).toEqual([
      expect.objectContaining({
        description: "Custom bash.",
        logicalPath: "tools/bash.ts",
        sourceId: "test-app:tools/bash.ts",
      }),
    ]);
    expect(compiled.sourceComposition.shadowed).toContainEqual({
      loser: expect.objectContaining({
        layer: "framework-default",
        owner: { feature: "tools/bash", kind: "framework" },
        sourceId: "eve:tools/bash.ts",
      }),
      slot: "tools/bash",
      winningSourceId: "test-app:tools/bash.ts",
    });
    expect(compiled.bindings["test-app:tools/bash.ts"]).toMatchObject({
      owner: { kind: "application" },
    });
    expect(compiled.bindings["eve:tools/bash.ts"]).toBeUndefined();
  });

  it("removes a framework tool through disableTool() and records the disabled slot", async () => {
    const applicationRegistry = createApplicationRegistry([
      {
        logicalPath: "tools/web_fetch.ts",
        loadNamespace: async () => ({ default: disableTool() }),
      },
    ]);

    const compiled = await compile(createRootManifest(), { applicationRegistry });

    expect(compiled.tools.map((tool) => tool.name)).not.toContain("web_fetch");
    expect(compiled.sourceComposition.disabled).toEqual([
      {
        disabledBy: expect.objectContaining({
          layer: "application",
          sourceId: "test-app:tools/web_fetch.ts",
        }),
        slot: "tools/web_fetch",
      },
    ]);
    expect(compiled.sourceComposition.shadowed).toContainEqual(
      expect.objectContaining({
        slot: "tools/web_fetch",
        winningSourceId: "test-app:tools/web_fetch.ts",
      }),
    );
    expect(compiled.bindings["test-app:tools/web_fetch.ts"]).toBeUndefined();
    expect(compiled.bindings["eve:tools/web_fetch.ts"]).toBeUndefined();
  });

  it("rejects a disable sentinel whose slot has no lower-precedence candidate", async () => {
    const applicationRegistry = createApplicationRegistry([
      {
        logicalPath: "tools/custom_only.ts",
        loadNamespace: async () => ({ default: disableTool() }),
      },
    ]);

    await expect(compile(createRootManifest(), { applicationRegistry })).rejects.toThrow(
      '"tools/custom_only.ts" disables "tools/custom_only", but no lower-precedence source provides it.',
    );
  });

  it("compiles the experimental Workflow sentinel into workflowTool without a tool row", async () => {
    const applicationRegistry = createApplicationRegistry([
      {
        logicalPath: "tools/workflow.ts",
        loadNamespace: async () => ({ default: experimental_workflow({ maxSubagents: 6 }) }),
      },
    ]);

    const compiled = await compile(createRootManifest(), { applicationRegistry });

    expect(compiled.workflowTool).toEqual({ maxSubagents: 6 });
    expect(compiled.tools.map((tool) => tool.name)).not.toContain("workflow");
    expect(compiled.bindings["test-app:tools/workflow.ts"]).toBeUndefined();
  });

  it("compiles webSearch() into an execute-less web_search row plus the selected provider", async () => {
    const applicationRegistry = createApplicationRegistry([
      {
        logicalPath: "tools/web_search.ts",
        loadNamespace: async () => ({ default: webSearch({ provider: "exa" }) }),
      },
    ]);

    const compiled = await compile(createRootManifest(), { applicationRegistry });

    expect(compiled.webSearchProvider).toBe("exa");
    expect(compiled.tools.filter((tool) => tool.name === "web_search")).toEqual([
      expect.objectContaining({
        description: WEB_SEARCH_TOOL_DESCRIPTION,
        inputSchema: null,
        sourceId: "test-app:tools/web_search.ts",
      }),
    ]);
    expect(compiled.sourceComposition.shadowed).toContainEqual(
      expect.objectContaining({
        slot: "tools/web_search",
        winningSourceId: "test-app:tools/web_search.ts",
      }),
    );
  });

  it("leaves the provider unset when only the framework web_search default composes", async () => {
    const compiled = await compile(createRootManifest());

    expect(compiled.webSearchProvider).toBeUndefined();
    expect(compiled.tools.filter((tool) => tool.name === "web_search")).toEqual([
      expect.objectContaining({ inputSchema: null, sourceId: "eve:tools/web_search.ts" }),
    ]);
  });

  it("requires experimental.tasks for background tools", async () => {
    const backgroundTool: ProgrammaticAgentModule = {
      logicalPath: "tools/export.ts",
      loadNamespace: async () => ({
        default: defineTool({
          description: "Starts an export.",
          execution: "background",
          inputSchema: z.object({}),
          execute: () => ({ ok: true }),
        }),
      }),
    };

    await expect(
      compile(createRootManifest(), {
        applicationRegistry: createApplicationRegistry([backgroundTool]),
      }),
    ).rejects.toThrow(
      'Background tool "export" requires experimental.tasks: true in the root agent config.',
    );

    const withTasks = await compile(createRootManifest(), {
      applicationRegistry: createApplicationRegistry([
        backgroundTool,
        {
          logicalPath: "agent.ts",
          loadNamespace: async () => ({
            default: defineAgent({ model: "openai/gpt-5.5", experimental: { tasks: true } }),
          }),
        },
      ]),
    });
    expect(withTasks.tools).toContainEqual(
      expect.objectContaining({ execution: "background", name: "export" }),
    );
    expect(withTasks.config.source?.sourceId).toBe("test-app:agent.ts");
    expect(withTasks.sourceComposition.shadowed).toContainEqual(
      expect.objectContaining({ slot: "agent", winningSourceId: "test-app:agent.ts" }),
    );
  });

  it("rejects two sources that compile to the same public tool name", async () => {
    const applicationRegistry = createApplicationRegistry([
      {
        logicalPath: "tools/billing/refund.ts",
        loadNamespace: async () => ({
          default: defineTool({
            description: "Refund a charge.",
            inputSchema: z.object({}),
            execute: () => ({ ok: true }),
          }),
        }),
      },
      {
        logicalPath: "tools/billing-refund.ts",
        loadNamespace: async () => ({
          default: defineTool({
            description: "Refund a charge.",
            inputSchema: z.object({}),
            execute: () => ({ ok: true }),
          }),
        }),
      },
    ]);

    await expect(compile(createRootManifest(), { applicationRegistry })).rejects.toThrow(
      'Agent "root" compiled more than one tool named "billing-refund".',
    );
  });

  it("merges agent-owned and extension-owned external dependencies", async () => {
    const extensionManifest = createAgentSourceManifest({
      agentId: "research-extension",
      agentRoot: "/packages/research/dist/extension",
      appRoot: "/packages/research",
    });
    const manifest = createRootManifest({
      extensions: [createModuleSourceRef({ logicalPath: "extensions/research.ts" })],
      resolvedExtensions: [
        {
          namespace: "research",
          specifier: "@acme/research",
          packageName: "@acme/research",
          packageRoot: "/packages/research",
          sourceRoot: "/packages/research/dist/extension",
          manifest: extensionManifest,
          externalDependencies: ["extension-only", "shared"],
        },
      ],
    });
    const applicationRegistry = createApplicationRegistry([
      {
        logicalPath: "agent.ts",
        loadNamespace: async () => ({
          default: defineAgent({
            model: "openai/gpt-5.5",
            build: { externalDependencies: ["agent-only", "shared"] },
          }),
        }),
      },
    ]);

    const compiled = await compile(manifest, { applicationRegistry });

    expect(compiled.config.build?.externalDependencies).toEqual([
      "agent-only",
      "shared",
      "extension-only",
    ]);
    expect(compiled.extensionMounts).toEqual([
      expect.objectContaining({
        namespace: "research",
        externalDependencies: ["extension-only", "shared"],
        mountLogicalPath: "extensions/research.ts",
      }),
    ]);
    expect(compiled.bindings["extensions/research.ts"]).toMatchObject({
      backing: { kind: "filesystem" },
      owner: { kind: "application" },
    });
  });

  describe("subagents", () => {
    it("composes framework node defaults into subagents without root-only sources", async () => {
      loadFilesystemBackingsAs(
        defineAgent({ description: "Research the request.", model: "openai/gpt-5.5" }),
      );

      const compiled = await compile(createManifestWithSubagent(), {
        applicationRegistry: createApplicationRegistry([
          {
            logicalPath: "tools/root_only.ts",
            loadNamespace: async () => ({
              default: defineTool({
                description: "Root tool.",
                inputSchema: z.object({}),
                execute: () => ({ ok: true }),
              }),
            }),
          },
        ]),
      });

      expect(compiled.subagents).toHaveLength(1);
      const child = compiled.subagents[0]!;
      expect(child.description).toBe("Research the request.");
      const childToolNames = child.agent.tools.map((tool) => tool.name).sort();
      expect(childToolNames).toEqual([
        "ask_question",
        "bash",
        "load_skill",
        "read_file",
        "todo",
        "web_fetch",
        "web_search",
        "write_file",
      ]);
      expect(childToolNames).not.toContain("root_only");
      expect(child.agent.channels).toEqual([]);
      expect(child.agent.sandbox.sourceId).toBe("eve:sandbox.ts");
      expect(compiled.tools.map((tool) => tool.name)).toContain("root_only");
    });

    it("rejects Workflow runtime configuration on subagents", async () => {
      loadFilesystemBackingsAs(
        defineAgent({
          description: "Research subagent",
          model: "openai/gpt-5.5",
          experimental: { workflow: { world: "@workflow/world-postgres" } },
        }),
      );

      await expect(compile(createManifestWithSubagent())).rejects.toThrow(
        'Remove "experimental.workflow" from "research"',
      );
    });

    it("rejects background-task configuration on subagents", async () => {
      loadFilesystemBackingsAs(
        defineAgent({
          description: "Research subagent",
          model: "openai/gpt-5.5",
          experimental: { tasks: true },
        }),
      );

      await expect(compile(createManifestWithSubagent())).rejects.toThrow(
        'Remove "experimental.tasks" from "research"',
      );
    });
  });
});

function createManifestWithSubagent(): AgentSourceManifest {
  const subagentManifest = createAgentSourceManifest({
    agentId: "research",
    agentRoot: "/app/agent/subagents/research",
    appRoot: "/app",
    configModule: createModuleSourceRef({ logicalPath: "agent.ts" }),
  });
  return createRootManifest({
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
}
