import { asSchema } from "ai";
import { describe, expect, it } from "vitest";
import { z } from "#compiled/zod/index.js";
import {
  type CompiledAgentManifest,
  type CompiledChannelDefinition,
  ROOT_COMPILED_AGENT_NODE_ID,
} from "../src/compiler/manifest.js";
import type { CompiledModuleMap } from "../src/compiler/module-map.js";
import { TEST_DEFAULT_MODEL_ID } from "../src/internal/testing/app-harness.js";
import {
  createStubCompiledAgentManifest as createCompiledAgentManifest,
  TEST_COMPILED_AGENT_CONFIG_BINDING,
  TEST_COMPILED_AGENT_CONFIG_MODULE,
  TEST_COMPILED_AGENT_CONFIG_SOURCE,
  TEST_COMPILED_SANDBOX_MODULE,
  TEST_COMPILED_SANDBOX_SOURCE_ID,
} from "../src/internal/testing/compiled-manifest.js";
import { resolveAgent as resolveAgentBase } from "../src/runtime/resolve-agent.js";
import { ResolveAgentError } from "../src/runtime/resolve-helpers.js";
import { serializeInputSchema } from "../src/shared/tool-schema.js";

function resolveAgent(input: Parameters<typeof resolveAgentBase>[0]) {
  const moduleMap: CompiledModuleMap = {
    nodes: Object.fromEntries(
      Object.entries(input.moduleMap.nodes).map(([nodeId, scope]) => [
        nodeId,
        {
          modules: {
            ...(nodeId === ROOT_COMPILED_AGENT_NODE_ID && "config" in input.manifest
              ? { [input.manifest.config.source.sourceId]: TEST_COMPILED_AGENT_CONFIG_MODULE }
              : {}),
            [TEST_COMPILED_SANDBOX_SOURCE_ID]: TEST_COMPILED_SANDBOX_MODULE,
            ...scope.modules,
          },
        },
      ]),
    ),
  };
  return resolveAgentBase({ ...input, moduleMap });
}

describe("resolveAgent", () => {
  it("hydrates compiled authored metadata and attaches tool execute functions", async () => {
    const slackChannelDefinition: CompiledChannelDefinition = {
      kind: "channel",
      name: "slack",
      method: "POST",
      urlPath: "/slack",
      logicalPath: "channels/slack.mjs",
      sourceId: "channels/slack.mjs",
      sourceKind: "module",
    };
    const manifest = createCompiledAgentManifest({
      kernelPlan: { prepared: [] },
      agentRoot: "/app/agent",
      appRoot: "/app",
      bindings: [
        { logicalPath: "agent.mjs", sourceId: "agent.mjs" },
        { logicalPath: "channels/slack.mjs", sourceId: "channels/slack.mjs" },
        { logicalPath: "sandbox/sandbox.mjs", sourceId: "sandbox/sandbox.mjs" },
        {
          logicalPath: "skills/route-weather.mjs",
          sourceId: "skills/route-weather.mjs",
        },
        { logicalPath: "tools/get-weather.mjs", sourceId: "tools/get-weather.mjs" },
      ],
      channelRoutes: { effective: [slackChannelDefinition], preflight: [], shadowed: [] },
      config: {
        model: {
          id: "anthropic/claude-sonnet-4.5",
          routing: { kind: "gateway", target: "anthropic" },
        },
        name: "weather-agent",
        source: {
          exportName: "config",
          sourceKind: "module",
          logicalPath: "agent.mjs",
          sourceId: "agent.mjs",
        },
      },
      instructions: [
        {
          content: "You are a weather-focused assistant.",
          name: "instructions",
          logicalPath: "instructions.md",
          role: "system",
          sourceId: "instructions.md",
          sourceKind: "markdown",
        },
      ],
      sandbox: {
        logicalPath: "sandbox/sandbox.mjs",
        sourceHash: "sandbox-source-hash",
        sourceId: "sandbox/sandbox.mjs",
        sourceKind: "module",
      },
      skills: [
        {
          description: "Use the weather tool before answering forecast questions.",
          logicalPath: "skills/get-weather.md",
          markdown: "Call the weather tool before answering forecast questions.",
          name: "get-weather",
          sourceId: "skills/get-weather.md",
          sourceKind: "markdown",
        },
        {
          description: "Route weather questions.",
          logicalPath: "skills/route-weather.mjs",
          markdown: "Route weather questions to the weather tool.",
          name: "route-weather",
          sourceId: "skills/route-weather.mjs",
          sourceKind: "module",
        },
        {
          description: "Escalate complex weather research tasks.",
          logicalPath: "skills/research/SKILL.md",
          markdown: "Research complex weather questions before returning findings.",
          name: "research",
          referencesPath: "/app/agent/skills/research/references",
          rootPath: "/app/agent/skills/research",
          scriptsPath: "/app/agent/skills/research/scripts",
          skillId: "research",
          skillFilePath: "/app/agent/skills/research/SKILL.md",
          sourceId: "skills/research/SKILL.md",
          sourceKind: "skill-package",
        },
      ],
      tools: [
        {
          description: "Get the current weather for a city.",
          inputSchema: {
            properties: {
              city: {
                type: "string",
              },
            },
            required: ["city"],
            type: "object",
          },
          logicalPath: "tools/get-weather.mjs",
          name: "get_weather",
          sourceId: "tools/get-weather.mjs",
          sourceKind: "module",
        },
      ],
    });
    const moduleMap: CompiledModuleMap = {
      nodes: {
        [ROOT_COMPILED_AGENT_NODE_ID]: {
          modules: {
            "channels/slack.mjs": {
              default() {
                // Minimal CompiledChannel shape (what `defineChannel`
                // returns). Avoids importing `defineChannel` from a
                // test fixture module.
                return {
                  __kind: "eve:channel",
                  routes: [
                    {
                      method: "POST",
                      path: "/slack",
                      async handler() {
                        return new Response("ok");
                      },
                    },
                  ],
                  adapter: { kind: "channel" },
                };
              },
            },
            "sandbox/sandbox.mjs": {
              default() {
                return {
                  description: "Use this sandbox for repository shell work.",
                  onSession() {
                    return undefined;
                  },
                };
              },
            },
            "tools/get-weather.mjs": {
              default() {
                return {
                  description: "Get the current weather for a city.",
                  execute(input: { city: string }) {
                    return input;
                  },
                  inputSchema: {
                    properties: {
                      city: {
                        type: "string",
                      },
                    },
                    required: ["city"],
                    type: "object",
                  },
                  name: "get_weather",
                };
              },
            },
          },
        },
      },
    };

    const resolved = await resolveAgent({
      manifest,
      moduleMap,
    });
    const [resolvedChannel] = resolved.channels;

    expect(resolved.config?.name).toBe("weather-agent");
    expect(resolved.config).toEqual({
      compaction: {},
      model: {
        id: "anthropic/claude-sonnet-4.5",
      },
      name: "weather-agent",
      source: {
        exportName: "config",
        logicalPath: "agent.mjs",
        sourceId: "agent.mjs",
        sourceKind: "module",
      },
    });
    if (resolvedChannel === undefined) {
      throw new Error("Expected one resolved channel.");
    }
    expect(resolvedChannel.name).toBe("slack");
    expect(resolvedChannel.method).toBe("POST");
    expect(resolvedChannel.urlPath).toBe("/slack");
    expect(typeof resolvedChannel.handler).toBe("function");
    expect(resolved.channels).toHaveLength(1);
    expect(resolved.metadata).toEqual({
      agentRoot: "/app/agent",
      appRoot: "/app",
      diagnosticsSummary: {
        errors: 0,
        warnings: 0,
      },
    });
    expect(resolved.instructions).toEqual([
      {
        content: "You are a weather-focused assistant.",
        logicalPath: "instructions.md",
        name: "instructions",
        owner: { kind: "application" },
        role: "system",
        sourceId: "instructions.md",
        sourceKind: "markdown",
      },
    ]);
    expect(resolved.sandbox).toEqual({
      backend: expect.objectContaining({
        create: expect.any(Function),
        name: expect.any(String),
      }),
      bootstrap: undefined,
      description: undefined,
      exportName: undefined,
      logicalPath: "sandbox/sandbox.mjs",
      onSession: expect.any(Function),
      revalidationKey: undefined,
      sourceHash: "sandbox-source-hash",
      sourceId: "sandbox/sandbox.mjs",
      sourceKind: "module",
    });
    expect(resolved.skills).toEqual([
      {
        description: "Use the weather tool before answering forecast questions.",
        logicalPath: "skills/get-weather.md",
        markdown: "Call the weather tool before answering forecast questions.",
        name: "get-weather",
        sourceId: "skills/get-weather.md",
        sourceKind: "markdown",
      },
      {
        description: "Route weather questions.",
        logicalPath: "skills/route-weather.mjs",
        markdown: "Route weather questions to the weather tool.",
        name: "route-weather",
        sourceId: "skills/route-weather.mjs",
        sourceKind: "module",
      },
      {
        description: "Escalate complex weather research tasks.",
        logicalPath: "skills/research/SKILL.md",
        markdown: "Research complex weather questions before returning findings.",
        name: "research",
        referencesPath: "/app/agent/skills/research/references",
        rootPath: "/app/agent/skills/research",
        scriptsPath: "/app/agent/skills/research/scripts",
        skillId: "research",
        skillFilePath: "/app/agent/skills/research/SKILL.md",
        sourceId: "skills/research/SKILL.md",
        sourceKind: "skill-package",
      },
    ]);
    expect(resolved.workspaceSpec).toEqual({
      rootEntries: [],
    });
    expect(resolved.tools).toHaveLength(1);
    expect(resolved.tools[0]).toMatchObject({
      description: "Get the current weather for a city.",
      logicalPath: "tools/get-weather.mjs",
      name: "get_weather",
      sourceId: "tools/get-weather.mjs",
      sourceKind: "module",
      sourceOwner: { kind: "application" },
    });
    expect(serializeInputSchema(resolved.tools[0]!.inputSchema!)).toMatchObject({
      properties: {
        city: {
          type: "string",
        },
      },
      required: ["city"],
      type: "object",
    });
    expect(
      resolved.tools[0]?.execute?.({ city: "Brooklyn" }, { messages: [], toolCallId: "call_1" }),
    ).toEqual({
      city: "Brooklyn",
    });
  });

  it("derives instructions ownership from the canonical compiled source graph", async () => {
    const extensionSourceRoot = "/app/node_modules/@acme/crm";
    const extensionOwner = {
      kind: "extension",
      namespace: "crm",
      packageName: "@acme/crm",
    } as const;
    const moduleManifest = createCompiledAgentManifest({
      agentRoot: "/app/agent",
      appRoot: "/app",
      bindings: [
        TEST_COMPILED_AGENT_CONFIG_BINDING,
        {
          binding: {
            backing: {
              externalDependencies: [],
              kind: "filesystem",
              sourcePath: "/app/agent/extensions/crm.ts",
            },
            owner: { kind: "application" },
          },
          logicalPath: "extensions/crm.ts",
          sourceId: "extensions/crm.ts",
        },
        {
          binding: {
            backing: {
              extensionScope: {
                namespace: "acme-crm",
                sourceRoot: extensionSourceRoot,
              },
              externalDependencies: [],
              kind: "filesystem",
              sourcePath: `${extensionSourceRoot}/instructions/policy.ts`,
            },
            owner: extensionOwner,
          },
          logicalPath: "instructions/policy.ts",
          sourceId: "opaque-module-source",
        },
      ],
      config: {
        model: {
          id: TEST_DEFAULT_MODEL_ID,
          routing: { kind: "gateway", target: "openai" },
        },
        name: "module-owner",
        source: TEST_COMPILED_AGENT_CONFIG_SOURCE,
      },
      extensionMounts: [
        {
          externalDependencies: [],
          mountLogicalPath: "extensions/crm.ts",
          mountSourceId: "extensions/crm.ts",
          namespace: "crm",
          packageName: "@acme/crm",
          packageNamespace: "acme-crm",
          sourceRoot: extensionSourceRoot,
        },
      ],
      instructions: [
        {
          content: "Module policy.",
          logicalPath: "instructions/policy.ts",
          name: "policy",
          role: "system",
          sourceId: "opaque-module-source",
          sourceKind: "module",
        },
      ],
    });

    const resolvedModule = await resolveAgent({
      manifest: moduleManifest,
      moduleMap: { nodes: { [ROOT_COMPILED_AGENT_NODE_ID]: { modules: {} } } },
    });
    expect(resolvedModule.instructions[0]?.owner).toEqual(extensionOwner);

    const markdownBase = createCompiledAgentManifest({
      agentRoot: "/app/agent",
      appRoot: "/app",
      bindings: [TEST_COMPILED_AGENT_CONFIG_BINDING],
      config: {
        model: {
          id: TEST_DEFAULT_MODEL_ID,
          routing: { kind: "gateway", target: "openai" },
        },
        name: "markdown-owner",
        source: TEST_COMPILED_AGENT_CONFIG_SOURCE,
      },
      instructions: [
        {
          content: "Markdown policy.",
          logicalPath: "instructions/policy.md",
          name: "policy",
          role: "system",
          sourceId: "opaque-markdown-source",
          sourceKind: "markdown",
        },
      ],
    });
    const markdownManifest: CompiledAgentManifest = {
      ...markdownBase,
      sourceComposition: {
        ...markdownBase.sourceComposition,
        selected: markdownBase.sourceComposition.selected.map((entry) =>
          entry.sourceKind === "non-module" && entry.source.sourceId === "opaque-markdown-source"
            ? {
                ...entry,
                source: {
                  ...entry.source,
                  layer: "extension-package",
                  owner: extensionOwner,
                },
              }
            : entry,
        ),
      },
    };

    const resolvedMarkdown = await resolveAgent({
      manifest: markdownManifest,
      moduleMap: { nodes: { [ROOT_COMPILED_AGENT_NODE_ID]: { modules: {} } } },
    });
    expect(resolvedMarkdown.instructions[0]?.owner).toEqual(extensionOwner);
  });

  it("reattaches live standard-schema validators from authored tool exports", async () => {
    const schema = z.object({
      maxRows: z.number().int().positive().default(200),
      sql: z.string().default("SELECT 1"),
    });
    const manifest = createCompiledAgentManifest({
      kernelPlan: { prepared: [] },
      agentRoot: "/app/agent",
      appRoot: "/app",
      bindings: [
        TEST_COMPILED_AGENT_CONFIG_BINDING,
        { logicalPath: "tools/query.mjs", sourceId: "tools/query.mjs" },
      ],
      config: {
        model: {
          id: TEST_DEFAULT_MODEL_ID,
          routing: { kind: "gateway", target: "openai" },
        },
        name: "weather-agent",
        source: TEST_COMPILED_AGENT_CONFIG_SOURCE,
      },
      tools: [
        {
          description: "Execute a query.",
          inputSchema: {
            additionalProperties: false,
            properties: {
              maxRows: {
                type: "number",
              },
              sql: {
                type: "string",
              },
            },
            type: "object",
          },
          logicalPath: "tools/query.mjs",
          name: "query",
          sourceId: "tools/query.mjs",
          sourceKind: "module",
        },
      ],
    });
    const moduleMap: CompiledModuleMap = {
      nodes: {
        [ROOT_COMPILED_AGENT_NODE_ID]: {
          modules: {
            "tools/query.mjs": {
              default() {
                return {
                  description: "Execute a query.",
                  execute(input: unknown) {
                    return input;
                  },
                  inputSchema: schema,
                  name: "query",
                };
              },
            },
          },
        },
      },
    };

    const resolved = await resolveAgent({
      manifest,
      moduleMap,
    });
    const inputSchema = resolved.tools[0]?.inputSchema;
    expect(inputSchema).toBeDefined();

    const sdkSchema = asSchema(inputSchema!);
    const result = await sdkSchema.validate!({});

    expect(result).toEqual({
      success: true,
      value: {
        maxRows: 200,
        sql: "SELECT 1",
      },
    });
  });

  it("preserves required compiled config provenance", async () => {
    const resolved = await resolveAgent({
      manifest: createCompiledAgentManifest({
        kernelPlan: { prepared: [] },
        agentRoot: "/app/agent",
        appRoot: "/app",
        bindings: [TEST_COMPILED_AGENT_CONFIG_BINDING],
        config: {
          model: {
            id: TEST_DEFAULT_MODEL_ID,
            routing: { kind: "gateway", target: "openai" },
          },
          name: "weather-agent",
          source: TEST_COMPILED_AGENT_CONFIG_SOURCE,
        },
      }),
      moduleMap: {
        nodes: {
          [ROOT_COMPILED_AGENT_NODE_ID]: {
            modules: {},
          },
        },
      },
    });

    expect(resolved.config?.name).toBe("weather-agent");
    expect(resolved.config).toEqual({
      compaction: {},
      model: {
        contextWindowTokens: undefined,
        id: TEST_DEFAULT_MODEL_ID,
        maxOutputTokens: undefined,
        providerOptions: undefined,
      },
      name: "weather-agent",
      source: {
        exportName: undefined,
        logicalPath: "agent.ts",
        sourceId: "test:stub-agent-config",
        sourceKind: "module",
      },
    });
    expect(resolved.instructions).toEqual([]);
    expect(resolved.sandbox.logicalPath).toBe("sandbox.ts");
    expect(resolved.skills).toEqual([]);
    expect(resolved.tools).toEqual([]);
    expect(resolved.workspaceSpec).toEqual({
      rootEntries: [],
    });
  });

  it("threads the compiled sandbox workspace folder into the resolved agent", async () => {
    const resolved = await resolveAgent({
      manifest: createCompiledAgentManifest({
        kernelPlan: { prepared: [] },
        agentRoot: "/app/agent",
        appRoot: "/app",
        bindings: [TEST_COMPILED_AGENT_CONFIG_BINDING],
        config: {
          model: { id: TEST_DEFAULT_MODEL_ID, routing: { kind: "gateway", target: "openai" } },
          name: "weather-agent",
          source: TEST_COMPILED_AGENT_CONFIG_SOURCE,
        },
        sandboxWorkspaces: [
          {
            logicalPath: "sandbox/workspace",
            rootEntries: ["prompts/", "seed.txt"],
            sourceId: "sandbox/workspace",
            sourcePath: "/app/agent/sandbox/workspace",
          },
        ],
      }),
      moduleMap: {
        nodes: {
          [ROOT_COMPILED_AGENT_NODE_ID]: {
            modules: {},
          },
        },
      },
    });

    // The sandbox workspace's root entries flow into the prompt-facing
    // workspace spec and the byte-free resource-root descriptor the
    // runtime graph builder hands to the registry.
    expect(resolved.workspaceSpec.rootEntries).toEqual(["prompts/", "seed.txt"]);
    expect(resolved.workspaceResourceRoot.rootEntries).toEqual(["prompts/", "seed.txt"]);
  });

  it("preserves source-backed model references already compiled into the manifest", async () => {
    const resolved = await resolveAgent({
      manifest: createCompiledAgentManifest({
        kernelPlan: { prepared: [] },
        agentRoot: "/app/agent",
        appRoot: "/app",
        bindings: [{ logicalPath: "agent.mjs", sourceId: "agent.mjs" }],
        config: {
          model: {
            id: "test-provider/weather-pro",
            source: {
              sourceKind: "module",
              logicalPath: "agent.mjs",
              sourceId: "agent.mjs",
            },
            routing: { kind: "external", provider: "test-provider" },
          },
          name: "weather-agent",
          source: {
            logicalPath: "agent.mjs",
            sourceId: "agent.mjs",
            sourceKind: "module",
          },
        },
      }),
      moduleMap: {
        nodes: {
          [ROOT_COMPILED_AGENT_NODE_ID]: {
            modules: {},
          },
        },
      },
    });

    expect(resolved.config?.model).toEqual({
      id: "test-provider/weather-pro",
      source: {
        sourceKind: "module",
        logicalPath: "agent.mjs",
        sourceId: "agent.mjs",
      },
    });
  });

  it("preserves model options on resolved runtime model references", async () => {
    const resolved = await resolveAgent({
      manifest: createCompiledAgentManifest({
        kernelPlan: { prepared: [] },
        agentRoot: "/app/agent",
        appRoot: "/app",
        bindings: [TEST_COMPILED_AGENT_CONFIG_BINDING],
        config: {
          model: {
            id: "anthropic/claude-opus-4.5-thinking",
            providerOptions: {
              anthropic: {
                thinking: {
                  budget_tokens: 1024,
                },
              },
            },
            routing: { kind: "gateway", target: "anthropic" },
          },
          name: "weather-agent",
          source: TEST_COMPILED_AGENT_CONFIG_SOURCE,
        },
      }),
      moduleMap: {
        nodes: {
          [ROOT_COMPILED_AGENT_NODE_ID]: {
            modules: {},
          },
        },
      },
    });

    expect(resolved.config?.model).toEqual({
      id: "anthropic/claude-opus-4.5-thinking",
      providerOptions: {
        anthropic: {
          thinking: {
            budget_tokens: 1024,
          },
        },
      },
    });
  });

  it("rejects invalid authored tool exports while resolving the compiled agent", async () => {
    const manifest = createCompiledAgentManifest({
      kernelPlan: { prepared: [] },
      agentRoot: "/app/agent",
      appRoot: "/app",
      bindings: [
        TEST_COMPILED_AGENT_CONFIG_BINDING,
        { logicalPath: "tools/get-weather.mjs", sourceId: "tools/get-weather.mjs" },
      ],
      config: {
        model: {
          id: TEST_DEFAULT_MODEL_ID,
          routing: { kind: "gateway", target: "openai" },
        },
        name: "weather-agent",
        source: TEST_COMPILED_AGENT_CONFIG_SOURCE,
      },
      tools: [
        {
          description: "Missing execute should fail runtime resolution.",
          inputSchema: null,
          logicalPath: "tools/get-weather.mjs",
          name: "get_weather",
          sourceId: "tools/get-weather.mjs",
          sourceKind: "module",
        },
      ],
    });

    await expect(
      resolveAgent({
        manifest,
        moduleMap: {
          nodes: {
            [ROOT_COMPILED_AGENT_NODE_ID]: {
              modules: {
                "tools/get-weather.mjs": {
                  default: async () => {
                    return {
                      description: "Missing execute should fail runtime resolution.",
                      name: "get_weather",
                    };
                  },
                },
              },
            },
          },
        },
      }),
    ).rejects.toBeInstanceOf(ResolveAgentError);
  });
});
