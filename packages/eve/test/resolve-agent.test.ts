import { asSchema } from "ai";
import { describe, expect, it } from "vitest";
import { z } from "#compiled/zod/index.js";
import {
  type CompiledChannelDefinition,
  createCompiledAgentManifest,
  ROOT_COMPILED_AGENT_NODE_ID,
  type CreateCompiledAgentResourcesInput,
} from "../src/compiler/manifest.js";
import type { CompiledModuleMap } from "../src/compiler/module-map.js";
import { TEST_DEFAULT_MODEL_ID } from "../src/internal/testing/app-harness.js";
import {
  EMPTY_CHANNEL_ROUTE_PLAN,
  EMPTY_SOURCE_COMPOSITION,
  testCompiledSandbox,
  testSandboxModuleNamespace,
} from "../src/internal/testing/compiled-node-fixtures.js";
import { ResolveAgentError, resolveAgent } from "../src/runtime/resolve-agent.js";
import { serializeInputSchema } from "../src/shared/tool-schema.js";

const TEST_SANDBOX = testCompiledSandbox();

function baseManifestInput(): Pick<
  CreateCompiledAgentResourcesInput,
  "agentRoot" | "appRoot" | "bindings" | "sandbox" | "sourceComposition"
> & { channelRoutes: typeof EMPTY_CHANNEL_ROUTE_PLAN } {
  return {
    agentRoot: "/app/agent",
    appRoot: "/app",
    bindings: {},
    channelRoutes: EMPTY_CHANNEL_ROUTE_PLAN,
    sandbox: TEST_SANDBOX,
    sourceComposition: EMPTY_SOURCE_COMPOSITION,
  };
}

function sandboxModules(): Record<string, Record<string, unknown>> {
  return { [TEST_SANDBOX.sourceId]: testSandboxModuleNamespace() };
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
      ...baseManifestInput(),
      channels: [slackChannelDefinition],
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
    expect(typeof resolvedChannel.fetch).toBe("function");
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
      inheritsParent: undefined,
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

  it("threads the compiled binding owner onto resolved tools", async () => {
    const manifest = createCompiledAgentManifest({
      ...baseManifestInput(),
      bindings: {
        "tools/get-weather.mjs": {
          backing: {
            externalDependencies: [],
            kind: "filesystem",
            sourcePath: "/app/agent/tools/get-weather.mjs",
          },
          logicalPath: "tools/get-weather.mjs",
          owner: { kind: "application" },
        },
      },
      config: {
        model: {
          id: TEST_DEFAULT_MODEL_ID,
          routing: { kind: "gateway", target: "openai" },
        },
        name: "weather-agent",
      },
      tools: [
        {
          description: "Get the current weather for a city.",
          inputSchema: null,
          logicalPath: "tools/get-weather.mjs",
          name: "get_weather",
          sourceId: "tools/get-weather.mjs",
          sourceKind: "module",
        },
      ],
    });

    const resolved = await resolveAgent({
      manifest,
      moduleMap: {
        nodes: {
          [ROOT_COMPILED_AGENT_NODE_ID]: {
            modules: {
              ...sandboxModules(),
              "tools/get-weather.mjs": {
                default: {
                  description: "Get the current weather for a city.",
                  execute(input: unknown) {
                    return input;
                  },
                },
              },
            },
          },
        },
      },
    });

    expect(resolved.tools[0]?.owner).toEqual({ kind: "application" });
  });

  it("reattaches live standard-schema validators from authored tool exports", async () => {
    const schema = z.object({
      maxRows: z.number().int().positive().default(200),
      sql: z.string().default("SELECT 1"),
    });
    const manifest = createCompiledAgentManifest({
      ...baseManifestInput(),
      config: {
        model: {
          id: TEST_DEFAULT_MODEL_ID,
          routing: { kind: "gateway", target: "openai" },
        },
        name: "weather-agent",
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
            ...sandboxModules(),
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

  it("resolves the framework default sandbox for a minimal compiled manifest", async () => {
    const resolved = await resolveAgent({
      manifest: createCompiledAgentManifest({
        ...baseManifestInput(),
        config: {
          model: {
            id: TEST_DEFAULT_MODEL_ID,
            routing: { kind: "gateway", target: "openai" },
          },
          name: "weather-agent",
        },
      }),
      moduleMap: {
        nodes: {
          [ROOT_COMPILED_AGENT_NODE_ID]: {
            modules: sandboxModules(),
          },
        },
      },
    });

    expect(resolved.config?.name).toBe("weather-agent");
    expect(resolved.config).toEqual({
      compaction: {},
      model: {
        id: TEST_DEFAULT_MODEL_ID,
      },
      name: "weather-agent",
    });
    expect(resolved.instructions).toEqual([]);
    // Every compiled node carries exactly one selected sandbox — the
    // framework default composes like any other source, so resolution
    // always yields a non-null sandbox.
    expect(resolved.sandbox).toMatchObject({
      backend: expect.objectContaining({
        create: expect.any(Function),
        name: expect.any(String),
      }),
      logicalPath: TEST_SANDBOX.logicalPath,
      sourceId: TEST_SANDBOX.sourceId,
      sourceKind: "module",
    });
    expect(resolved.skills).toEqual([]);
    expect(resolved.tools).toEqual([]);
    expect(resolved.workspaceSpec).toEqual({
      rootEntries: [],
    });
  });

  it("threads the compiled sandbox workspace folder into the resolved agent", async () => {
    const resolved = await resolveAgent({
      manifest: createCompiledAgentManifest({
        ...baseManifestInput(),
        config: {
          model: { id: TEST_DEFAULT_MODEL_ID, routing: { kind: "gateway", target: "openai" } },
          name: "weather-agent",
        },
        sandboxWorkspaces: [
          {
            logicalPath: "sandbox/workspace",
            rootEntries: ["seed.txt", "prompts/"],
            sourceId: "sandbox/workspace",
            sourcePath: "/app/agent/sandbox/workspace",
          },
        ],
      }),
      moduleMap: {
        nodes: {
          [ROOT_COMPILED_AGENT_NODE_ID]: {
            modules: sandboxModules(),
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
        ...baseManifestInput(),
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
        },
      }),
      moduleMap: {
        nodes: {
          [ROOT_COMPILED_AGENT_NODE_ID]: {
            modules: sandboxModules(),
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
        ...baseManifestInput(),
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
        },
      }),
      moduleMap: {
        nodes: {
          [ROOT_COMPILED_AGENT_NODE_ID]: {
            modules: sandboxModules(),
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
      ...baseManifestInput(),
      config: {
        model: {
          id: TEST_DEFAULT_MODEL_ID,
          routing: { kind: "gateway", target: "openai" },
        },
        name: "weather-agent",
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
                ...sandboxModules(),
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
