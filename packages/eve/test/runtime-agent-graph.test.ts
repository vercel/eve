import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type CompiledAgentDefinition,
  ROOT_COMPILED_AGENT_NODE_ID,
} from "../src/compiler/manifest.js";
import type { CompiledModuleMap } from "../src/compiler/module-map.js";
import { defineAgent } from "../src/public/definitions/agent.js";
import { defineDynamic } from "../src/public/definitions/tool.js";
import { createNodeHarnessTools } from "../src/execution/node-step.js";
import { TEST_DEFAULT_MODEL_ID } from "../src/internal/testing/app-harness.js";
import {
  createStubCompiledAgentManifest as createCompiledAgentManifest,
  createStubCompiledAgentNodeManifest as createCompiledAgentNodeManifest,
  createTestCompiledAgentResources as createCompiledAgentResources,
  createTestCompiledRemoteAgentNode,
  TEST_COMPILED_AGENT_CONFIG_BINDING,
  TEST_COMPILED_AGENT_CONFIG_MODULE,
  TEST_COMPILED_AGENT_CONFIG_SOURCE,
  TEST_COMPILED_SANDBOX_MODULE,
  TEST_COMPILED_SANDBOX_SOURCE_ID,
} from "../src/internal/testing/compiled-manifest.js";
import { ROOT_RUNTIME_AGENT_NODE_ID } from "../src/runtime/graph.js";
import { resolveRuntimeAgentGraph as resolveRuntimeAgentGraphBase } from "../src/runtime/resolve-agent-graph.js";

function resolveRuntimeAgentGraph(input: Parameters<typeof resolveRuntimeAgentGraphBase>[0]) {
  const moduleMap: CompiledModuleMap = {
    nodes: Object.fromEntries(
      Object.entries(input.moduleMap.nodes).map(([nodeId, scope]) => [
        nodeId,
        {
          modules: {
            ...configModuleForNode(input.manifest, nodeId),
            [TEST_COMPILED_SANDBOX_SOURCE_ID]: TEST_COMPILED_SANDBOX_MODULE,
            ...scope.modules,
          },
        },
      ]),
    ),
  };
  return resolveRuntimeAgentGraphBase({ ...input, moduleMap });
}

function configModuleForNode(
  manifest: Parameters<typeof resolveRuntimeAgentGraphBase>[0]["manifest"],
  nodeId: string,
): Record<string, typeof TEST_COMPILED_AGENT_CONFIG_MODULE> {
  let compiledConfig: CompiledAgentDefinition | undefined;
  if (nodeId === ROOT_COMPILED_AGENT_NODE_ID && "config" in manifest) {
    compiledConfig = manifest.config;
  } else {
    const agent = manifest.subagents.find((node) => node.nodeId === nodeId)?.agent;
    if (agent !== undefined && "config" in agent) compiledConfig = agent.config;
  }
  return compiledConfig === undefined
    ? {}
    : { [compiledConfig.source.sourceId]: TEST_COMPILED_AGENT_CONFIG_MODULE };
}

const SUBAGENT_TOOL_INPUT_SCHEMA = {
  type: "object",
  properties: {
    message: {
      type: "string",
      description:
        "The message to send to the subagent. Provide all context the subagent needs to complete the task; the subagent does not see the parent's history.",
    },
  },
  required: ["message"],
  additionalProperties: false,
} as const;

describe("resolveRuntimeAgentGraph", () => {
  beforeEach(() => {
    vi.stubEnv("VERCEL", "1");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("defaults agents to the Vercel sandbox backend on hosted Vercel", async () => {
    const manifest = createCompiledAgentManifest({
      kernelPlan: { prepared: [] },
      agentRoot: "/app/agent",
      appRoot: "/app",
      bindings: [TEST_COMPILED_AGENT_CONFIG_BINDING],
      config: {
        model: {
          id: TEST_DEFAULT_MODEL_ID,
          routing: { kind: "gateway", target: "openai" },
        },
        name: "workspace-agent",
        source: TEST_COMPILED_AGENT_CONFIG_SOURCE,
      },
      skills: [
        {
          description: "Use the research checklist.",
          logicalPath: "skills/research.md",
          markdown: "Use the research checklist.",
          name: "research",
          sourceId: "skills/research.md",
          sourceKind: "markdown",
        },
      ],
      subagentEdges: [
        {
          childNodeId: "subagents/researcher",
          parentNodeId: ROOT_COMPILED_AGENT_NODE_ID,
        },
      ],
      subagents: [
        {
          agent: createCompiledAgentNodeManifest(
            {
              kernelPlan: { prepared: [] },
              agentRoot: "/app/agent/subagents/researcher",
              appRoot: "/app",
              bindings: [TEST_COMPILED_AGENT_CONFIG_BINDING],
              config: {
                description: "Investigate one task in depth.",
                model: {
                  id: TEST_DEFAULT_MODEL_ID,
                  routing: { kind: "gateway", target: "openai" },
                },
                name: "researcher",
                source: TEST_COMPILED_AGENT_CONFIG_SOURCE,
              },
              skills: [
                {
                  description: "Use the reviewer checklist.",
                  logicalPath: "skills/reviewer.md",
                  markdown: "Use the reviewer checklist.",
                  name: "reviewer",
                  sourceId: "skills/reviewer.md",
                  sourceKind: "markdown",
                },
              ],
            },
            { isRoot: false, nodeId: "subagents/researcher" },
          ),
          backing: {
            externalDependencies: [],
            kind: "filesystem",
            sourcePath: "/app/agent/subagents/researcher",
          },
          description: "Investigate one task in depth.",
          entryPath: "/app/agent/subagents/researcher",
          logicalPath: "subagents/researcher",
          name: "researcher",
          nodeId: "subagents/researcher",
          owner: { kind: "application" },
          rootPath: "/app/agent/subagents/researcher",
          sourceId: "subagents/researcher",
          sourceKind: "subagent",
        },
      ],
    });
    const graph = await resolveRuntimeAgentGraph({
      manifest,
      moduleMap: {
        nodes: {
          [ROOT_COMPILED_AGENT_NODE_ID]: {
            modules: {},
          },
          "subagents/researcher": {
            modules: {},
          },
        },
      },
    });

    expect(graph.root.sandboxRegistry.sandbox.definition.backend.name).toBe("vercel");
    expect(
      graph.nodesByNodeId.get("subagents/researcher")?.sandboxRegistry.sandbox.definition.backend
        .name,
    ).toBe("vercel");
  });

  it("keeps dynamic subagents out of the static toolset and resolves their handlers", async () => {
    const dynamic = defineDynamic({
      events: {
        "session.started": () =>
          defineAgent({
            description: "Research the request.",
            model: TEST_DEFAULT_MODEL_ID,
          }),
      },
    });
    const manifest = createCompiledAgentManifest({
      kernelPlan: { prepared: [] },
      agentRoot: "/app/agent",
      appRoot: "/app",
      bindings: [TEST_COMPILED_AGENT_CONFIG_BINDING],
      config: {
        model: {
          id: TEST_DEFAULT_MODEL_ID,
          routing: { kind: "gateway", target: "openai" },
        },
        name: "root",
        source: TEST_COMPILED_AGENT_CONFIG_SOURCE,
      },
      subagentEdges: [
        {
          childNodeId: "subagents/researcher",
          parentNodeId: ROOT_COMPILED_AGENT_NODE_ID,
        },
      ],
      subagents: [
        {
          agent: createCompiledAgentResources(
            {
              agentRoot: "/app/agent/subagents/researcher",
              appRoot: "/app",
              bindings: [{ logicalPath: "agent.ts", sourceId: "agent.ts" }],
              kernelPlan: { prepared: [] },
            },
            {
              additionalBindingReferences: [
                { logicalPath: "agent.ts", sourceId: "agent.ts", sourceKind: "module" },
              ],
              isRoot: false,
              nodeId: "subagents/researcher",
            },
          ),
          backing: {
            externalDependencies: [],
            kind: "filesystem",
            sourcePath: "/app/agent/subagents/researcher/agent.ts",
          },
          configResolver: {
            eventNames: ["session.started"],
            exportName: "resolveResearcher",
            logicalPath: "agent.ts",
            sourceId: "agent.ts",
            sourceKind: "module",
          },
          entryPath: "/app/agent/subagents/researcher/agent.ts",
          logicalPath: "subagents/researcher",
          name: "researcher",
          nodeId: "subagents/researcher",
          owner: { kind: "application" },
          rootPath: "/app/agent/subagents/researcher",
          sourceId: "subagents/researcher",
          sourceKind: "subagent",
        },
      ],
    });

    const graph = await resolveRuntimeAgentGraph({
      manifest,
      moduleMap: {
        nodes: {
          [ROOT_COMPILED_AGENT_NODE_ID]: { modules: {} },
          "subagents/researcher": {
            modules: {
              "agent.ts": { resolveResearcher: dynamic },
            },
          },
        },
      },
    });

    expect(graph.root.turnAgent.tools.some((tool) => tool.name === "researcher")).toBe(false);
    expect(graph.root.subagentRegistry.dynamicNodeIds).toContain("subagents/researcher");
    expect(graph.root.subagentRegistry.dynamicResolvers).toMatchObject([
      {
        eventNames: ["session.started"],
        exportName: "resolveResearcher",
        logicalPath: "agent.ts",
        name: "researcher",
        nodeId: "subagents/researcher",
        sourceId: "agent.ts",
        sourceKind: "module",
        subagentSource: {
          logicalPath: "subagents/researcher",
          sourceId: "subagents/researcher",
          sourceKind: "subagent",
        },
      },
    ]);
    expect(graph.nodesByNodeId.has("subagents/researcher")).toBe(true);
  });

  it("resolves recursive local subagents into a cached runtime graph bundle", async () => {
    const appRoot = "/app";
    const agentRoot = "/app/agent";
    const researcherRoot = "/app/agent/subagents/researcher";
    const reviewerRoot = "/app/agent/subagents/researcher/subagents/reviewer";
    const reviewerDefinition = defineAgent({
      description: "Review one draft.",
      model: TEST_DEFAULT_MODEL_ID,
    });
    const reviewerManifest = createCompiledAgentNodeManifest(
      {
        kernelPlan: { prepared: [] },
        agentRoot: reviewerRoot,
        appRoot,
        bindings: [TEST_COMPILED_AGENT_CONFIG_BINDING],
        config: {
          description: reviewerDefinition.description,
          model: {
            id: TEST_DEFAULT_MODEL_ID,
            routing: { kind: "gateway", target: "openai" },
          },
          name: "reviewer",
          source: TEST_COMPILED_AGENT_CONFIG_SOURCE,
        },
        instructions: [
          {
            content: "Review drafts carefully.",
            name: "reviewer-instructions",
            logicalPath: "instructions.md",
            role: "system",
            sourceId: "instructions.md",
            sourceKind: "markdown",
          },
        ],
      },
      { isRoot: false, nodeId: "subagents/researcher::subagents/reviewer" },
    );
    const researcherDefinition = defineAgent({
      description: "Investigate one task in depth.",
      model: TEST_DEFAULT_MODEL_ID,
    });
    const researcherManifest = createCompiledAgentNodeManifest(
      {
        kernelPlan: { prepared: [] },
        agentRoot: researcherRoot,
        appRoot,
        bindings: [
          TEST_COMPILED_AGENT_CONFIG_BINDING,
          { logicalPath: "tools/search.mjs", sourceId: "tools/search.mjs" },
        ],
        config: {
          description: researcherDefinition.description,
          model: {
            id: TEST_DEFAULT_MODEL_ID,
            routing: { kind: "gateway", target: "openai" },
          },
          name: "researcher",
          source: TEST_COMPILED_AGENT_CONFIG_SOURCE,
        },
        instructions: [
          {
            content: "Investigate one task in depth.",
            name: "researcher-instructions",
            logicalPath: "instructions.md",
            role: "system",
            sourceId: "instructions.md",
            sourceKind: "markdown",
          },
        ],
        subagentSources: [
          {
            backing: {
              externalDependencies: [],
              kind: "filesystem",
              sourcePath: reviewerRoot,
            },
            logicalPath: "subagents/reviewer",
            name: "reviewer",
            sourceId: "subagents/reviewer",
          },
        ],
        tools: [
          {
            description: "Search the web.",
            inputSchema: null,
            logicalPath: "tools/search.mjs",
            name: "search",
            sourceId: "tools/search.mjs",
            sourceKind: "module",
          },
        ],
      },
      { isRoot: false, nodeId: "subagents/researcher" },
    );
    const manifest = createCompiledAgentManifest({
      kernelPlan: { prepared: [] },
      agentRoot,
      appRoot,
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
      instructions: [
        {
          content: "Answer weather questions.",
          name: "instructions",
          logicalPath: "instructions.md",
          role: "system",
          sourceId: "instructions.md",
          sourceKind: "markdown",
        },
      ],
      subagentEdges: [
        {
          childNodeId: "subagents/researcher",
          parentNodeId: ROOT_COMPILED_AGENT_NODE_ID,
        },
        {
          childNodeId: "subagents/researcher::subagents/reviewer",
          parentNodeId: "subagents/researcher",
        },
      ],
      subagents: [
        {
          agent: researcherManifest,
          backing: {
            externalDependencies: [],
            kind: "filesystem",
            sourcePath: researcherRoot,
          },
          description: researcherDefinition.description!,
          entryPath: researcherRoot,
          logicalPath: "subagents/researcher",
          name: "researcher",
          nodeId: "subagents/researcher",
          owner: { kind: "application" },
          rootPath: researcherRoot,
          sourceId: "subagents/researcher",
          sourceKind: "subagent",
        },
        {
          agent: reviewerManifest,
          backing: {
            externalDependencies: [],
            kind: "filesystem",
            sourcePath: reviewerRoot,
          },
          description: reviewerDefinition.description!,
          entryPath: reviewerRoot,
          logicalPath: "subagents/reviewer",
          name: "reviewer",
          nodeId: "subagents/researcher::subagents/reviewer",
          owner: { kind: "application" },
          rootPath: reviewerRoot,
          sourceId: "subagents/reviewer",
          sourceKind: "subagent",
        },
      ],
      tools: [
        {
          description: "Get the weather.",
          inputSchema: null,
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
            "tools/get-weather.mjs": {
              default: {
                description: "Get the weather.",
                execute(input: unknown) {
                  return input;
                },
                name: "get_weather",
              },
            },
          },
        },
        "subagents/researcher": {
          modules: {
            "tools/search.mjs": {
              default: {
                description: "Search the web.",
                execute(input: unknown) {
                  return input;
                },
                name: "search",
              },
            },
          },
        },
        "subagents/researcher::subagents/reviewer": {
          modules: {},
        },
      },
    };

    const graph = await resolveRuntimeAgentGraph({
      manifest,
      moduleMap,
    });

    expect([...graph.nodesByNodeId.keys()].sort()).toEqual([
      ROOT_RUNTIME_AGENT_NODE_ID,
      "subagents/researcher",
      "subagents/researcher::subagents/reviewer",
    ]);
    expect(graph.root.turnAgent.tools).toMatchObject([
      {
        description: "Get the weather.",
        inputSchema: null,
        kind: "authored-tool",
        logicalPath: "tools/get-weather.mjs",
        name: "get_weather",
        sourceId: "tools/get-weather.mjs",
      },
      {
        description: "Investigate one task in depth.",
        inputSchema: SUBAGENT_TOOL_INPUT_SCHEMA,
        kind: "subagent",
        logicalPath: "subagents/researcher",
        name: "researcher",
        nodeId: "subagents/researcher",
        sourceId: "subagents/researcher",
      },
    ]);

    const researcherNode = graph.nodesByNodeId.get("subagents/researcher");
    const reviewerNode = graph.nodesByNodeId.get("subagents/researcher::subagents/reviewer");

    expect(researcherNode?.agent.config?.name).toBe("researcher");
    expect(researcherNode?.agent.instructions).toEqual([
      {
        content: "Investigate one task in depth.",
        name: "researcher-instructions",
        logicalPath: "instructions.md",
        owner: { kind: "application" },
        role: "system",
        sourceId: "instructions.md",
        sourceKind: "markdown",
      },
    ]);
    expect(researcherNode?.turnAgent.tools).toMatchObject([
      {
        description: "Search the web.",
        inputSchema: null,
        kind: "authored-tool",
        logicalPath: "tools/search.mjs",
        name: "search",
        sourceId: "tools/search.mjs",
      },
      {
        description: "Review one draft.",
        inputSchema: SUBAGENT_TOOL_INPUT_SCHEMA,
        kind: "subagent",
        logicalPath: "subagents/reviewer",
        name: "reviewer",
        nodeId: "subagents/researcher::subagents/reviewer",
        sourceId: "subagents/reviewer",
      },
    ]);
    expect(reviewerNode?.agent.instructions).toEqual([
      {
        content: "Review drafts carefully.",
        name: "reviewer-instructions",
        logicalPath: "instructions.md",
        owner: { kind: "application" },
        role: "system",
        sourceId: "instructions.md",
        sourceKind: "markdown",
      },
    ]);
  });

  it("resolves remote subagents from the owning node manifest only", async () => {
    const appRoot = "/app";
    const agentRoot = "/app/agent";
    const researcherRoot = "/app/agent/subagents/researcher";
    const researcherManifest = createCompiledAgentNodeManifest(
      {
        kernelPlan: { prepared: [] },
        agentRoot: researcherRoot,
        appRoot,
        bindings: [TEST_COMPILED_AGENT_CONFIG_BINDING],
        config: {
          description: "Investigate one task in depth.",
          model: {
            id: TEST_DEFAULT_MODEL_ID,
            routing: { kind: "gateway", target: "openai" },
          },
          name: "researcher",
          source: TEST_COMPILED_AGENT_CONFIG_SOURCE,
        },
        remoteAgents: [
          createTestCompiledRemoteAgentNode({
            backing: {
              externalDependencies: [],
              kind: "filesystem",
              sourcePath: `${researcherRoot}/subagents/qux.ts`,
            },
            configResolver: {
              logicalPath: "subagents/qux/agent.ts",
              sourceId: "subagents/qux::config",
              sourceKind: "module",
            },
            description: "Answer niche follow-up questions remotely.",
            entryPath: `${researcherRoot}/subagents/qux.ts`,
            logicalPath: "subagents/qux",
            name: "qux",
            nodeId: "subagents/researcher::subagents/qux.ts",
            owner: { kind: "application" },
            path: "/eve/v1/session",
            rootPath: researcherRoot,
            sourceId: "subagents/qux.ts",
            sourceKind: "subagent",
            url: "https://qux.example.com",
          }),
        ],
      },
      { isRoot: false, nodeId: "subagents/researcher" },
    );
    const manifest = createCompiledAgentManifest({
      kernelPlan: { prepared: [] },
      agentRoot,
      appRoot,
      bindings: [TEST_COMPILED_AGENT_CONFIG_BINDING],
      config: {
        model: {
          id: TEST_DEFAULT_MODEL_ID,
          routing: { kind: "gateway", target: "openai" },
        },
        name: "router",
        source: TEST_COMPILED_AGENT_CONFIG_SOURCE,
      },
      remoteAgents: [
        createTestCompiledRemoteAgentNode({
          backing: {
            externalDependencies: [],
            kind: "filesystem",
            sourcePath: `${agentRoot}/subagents/weather.ts`,
          },
          configResolver: {
            exportName: "resolveWeather",
            logicalPath: "subagents/weather/agent.ts",
            sourceId: "subagents/weather::config",
            sourceKind: "module",
          },
          description: "Answer weather questions remotely.",
          entryPath: `${agentRoot}/subagents/weather.ts`,
          logicalPath: "subagents/weather",
          name: "weather",
          nodeId: "subagents/weather.ts",
          owner: { kind: "application" },
          path: "/eve/v1/session",
          rootPath: agentRoot,
          sourceId: "subagents/weather.ts",
          sourceKind: "subagent",
        }),
      ],
      subagentEdges: [
        {
          childNodeId: "subagents/researcher",
          parentNodeId: ROOT_COMPILED_AGENT_NODE_ID,
        },
      ],
      subagents: [
        {
          agent: researcherManifest,
          backing: {
            externalDependencies: [],
            kind: "filesystem",
            sourcePath: researcherRoot,
          },
          description: "Investigate one task in depth.",
          entryPath: researcherRoot,
          logicalPath: "subagents/researcher",
          name: "researcher",
          nodeId: "subagents/researcher",
          owner: { kind: "application" },
          rootPath: researcherRoot,
          sourceId: "subagents/researcher",
          sourceKind: "subagent",
        },
      ],
    });
    const graph = await resolveRuntimeAgentGraph({
      manifest,
      moduleMap: {
        nodes: {
          [ROOT_COMPILED_AGENT_NODE_ID]: { modules: {} },
          "subagents/researcher": { modules: {} },
          "subagents/weather.ts": {
            modules: {
              "subagents/weather::config": {
                resolveWeather: {
                  description: "Answer weather questions remotely.",
                  kind: "remote",
                  path: "/eve/v1/session",
                  url: () => "https://weather.example.com",
                },
              },
            },
          },
          "subagents/researcher::subagents/qux.ts": {
            modules: {
              "subagents/qux::config": {
                default: {
                  description: "Answer niche follow-up questions remotely.",
                  kind: "remote",
                  path: "/eve/v1/session",
                  url: "https://qux.example.com",
                },
              },
            },
          },
        },
      },
    });
    const rootRemote = graph.root.subagentRegistry.subagentsByName.get("weather");
    const researcherNode = graph.nodesByNodeId.get("subagents/researcher");
    const nestedRemote = researcherNode?.subagentRegistry.subagentsByName.get("qux");

    expect([...graph.nodesByNodeId.keys()].sort()).toEqual([
      ROOT_RUNTIME_AGENT_NODE_ID,
      "subagents/researcher",
    ]);
    expect(graph.root.subagentRegistry.subagentsByName.has("qux")).toBe(false);
    expect(rootRemote?.prepared).toMatchObject({
      kind: "remote",
      logicalPath: "subagents/weather",
      name: "weather",
      nodeId: "subagents/weather.ts",
    });
    expect(rootRemote?.definition).toMatchObject({
      configResolver: {
        exportName: "resolveWeather",
        logicalPath: "subagents/weather/agent.ts",
        sourceId: "subagents/weather::config",
        sourceKind: "module",
      },
      kind: "remote",
      logicalPath: "subagents/weather",
      sourceId: "subagents/weather.ts",
      sourceKind: "subagent",
      url: "https://weather.example.com",
    });
    expect(nestedRemote?.prepared).toMatchObject({
      kind: "remote",
      logicalPath: "subagents/qux",
      name: "qux",
      nodeId: "subagents/researcher::subagents/qux.ts",
    });
    expect(nestedRemote?.definition).toMatchObject({
      kind: "remote",
      url: "https://qux.example.com",
    });
  });

  it("resolves a remote subagent url function from process.env at runtime", async () => {
    vi.stubEnv("WEATHER_AGENT_URL", "https://weather.internal.vercel.app");
    const agentRoot = "/app/agent";
    const manifest = createCompiledAgentManifest({
      kernelPlan: { prepared: [] },
      agentRoot,
      appRoot: "/app",
      bindings: [TEST_COMPILED_AGENT_CONFIG_BINDING],
      config: {
        model: {
          id: TEST_DEFAULT_MODEL_ID,
          routing: { kind: "gateway", target: "openai" },
        },
        name: "router",
        source: TEST_COMPILED_AGENT_CONFIG_SOURCE,
      },
      remoteAgents: [
        createTestCompiledRemoteAgentNode({
          backing: {
            externalDependencies: [],
            kind: "filesystem",
            sourcePath: `${agentRoot}/subagents/weather.ts`,
          },
          configResolver: {
            logicalPath: "subagents/weather/agent.ts",
            sourceId: "subagents/weather::config",
            sourceKind: "module",
          },
          description: "Answer weather questions remotely.",
          entryPath: `${agentRoot}/subagents/weather.ts`,
          logicalPath: "subagents/weather",
          name: "weather",
          nodeId: "subagents/weather.ts",
          owner: { kind: "application" },
          path: "/eve/v1/session",
          rootPath: agentRoot,
          sourceId: "subagents/weather.ts",
          sourceKind: "subagent",
        }),
      ],
    });
    const graph = await resolveRuntimeAgentGraph({
      manifest,
      moduleMap: {
        nodes: {
          [ROOT_COMPILED_AGENT_NODE_ID]: { modules: {} },
          "subagents/weather.ts": {
            modules: {
              "subagents/weather::config": {
                default: {
                  description: "Answer weather questions remotely.",
                  kind: "remote",
                  path: "/eve/v1/session",
                  url: () => process.env.WEATHER_AGENT_URL,
                },
              },
            },
          },
        },
      },
    });

    expect(graph.root.subagentRegistry.subagentsByName.get("weather")?.definition).toMatchObject({
      kind: "remote",
      url: "https://weather.internal.vercel.app",
    });
  });

  it("lets an authored tool replace a framework tool by name collision", async () => {
    const manifest = createCompiledAgentManifest({
      kernelPlan: { prepared: [] },
      agentRoot: "/app/agent",
      appRoot: "/app",
      bindings: [
        TEST_COMPILED_AGENT_CONFIG_BINDING,
        { logicalPath: "tools/bash.mjs", sourceId: "tools/bash.mjs" },
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
          description: "Run a vetted shell command in the project sandbox.",
          inputSchema: null,
          logicalPath: "tools/bash.mjs",
          name: "bash",
          sourceId: "tools/bash.mjs",
          sourceKind: "module",
        },
      ],
    });
    const moduleMap: CompiledModuleMap = {
      nodes: {
        [ROOT_COMPILED_AGENT_NODE_ID]: {
          modules: {
            "tools/bash.mjs": {
              default: {
                description: "Run a vetted shell command in the project sandbox.",
                execute(input: unknown) {
                  return { kind: "authored-bash", input };
                },
                name: "bash",
              },
            },
          },
        },
      },
    };

    const graph = await resolveRuntimeAgentGraph({ manifest, moduleMap });
    const tools = graph.root.turnAgent.tools;
    const bashEntries = tools.filter((tool) => tool.name === "bash");

    expect(bashEntries).toHaveLength(1);
    expect(bashEntries[0]).toMatchObject({
      description: "Run a vetted shell command in the project sandbox.",
      kind: "authored-tool",
      logicalPath: "tools/bash.mjs",
      name: "bash",
    });
    expect(tools.map((tool) => tool.name)).toEqual(["bash"]);
  });

  it("does not synthesize ordinary tools omitted from compiled artifacts", async () => {
    const manifest = createCompiledAgentManifest({
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
    });

    const graph = await resolveRuntimeAgentGraph({
      manifest,
      moduleMap: {
        nodes: {
          [ROOT_COMPILED_AGENT_NODE_ID]: {
            modules: {},
          },
        },
      },
    });

    expect(graph.root.turnAgent.tools).toEqual([]);
  });

  it("uses the compiled kernel plan as the only native tool authority", async () => {
    const manifest = createCompiledAgentManifest({
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
    });

    const graph = await resolveRuntimeAgentGraph({
      manifest,
      moduleMap: {
        nodes: {
          [ROOT_COMPILED_AGENT_NODE_ID]: {
            modules: {},
          },
        },
      },
    });

    expect(graph.root.agent.kernelPlan.prepared).toEqual(["agent", "ask_question", "final_output"]);
    const nativeTools = createNodeHarnessTools({
      kernelPlan: graph.root.agent.kernelPlan,
      node: graph.root,
    });
    expect([...nativeTools.keys()]).toEqual(["agent", "ask_question"]);
    expect(nativeTools.has("task_update")).toBe(false);
  });

  it("combines replacement and disable in one agent", async () => {
    const manifest = createCompiledAgentManifest({
      kernelPlan: { prepared: [] },
      agentRoot: "/app/agent",
      appRoot: "/app",
      bindings: [
        TEST_COMPILED_AGENT_CONFIG_BINDING,
        { logicalPath: "tools/bash.mjs", sourceId: "tools/bash.mjs" },
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
          description: "Sandboxed shell.",
          inputSchema: null,
          logicalPath: "tools/bash.mjs",
          name: "bash",
          sourceId: "tools/bash.mjs",
          sourceKind: "module",
        },
      ],
    });
    const moduleMap: CompiledModuleMap = {
      nodes: {
        [ROOT_COMPILED_AGENT_NODE_ID]: {
          modules: {
            "tools/bash.mjs": {
              default: {
                description: "Sandboxed shell.",
                execute(input: unknown) {
                  return input;
                },
                name: "bash",
              },
            },
          },
        },
      },
    };

    const graph = await resolveRuntimeAgentGraph({ manifest, moduleMap });
    const tools = graph.root.turnAgent.tools;

    expect(tools.map((tool) => tool.name)).toEqual(["bash"]);
    expect(tools.find((tool) => tool.name === "bash")).toMatchObject({
      description: "Sandboxed shell.",
      logicalPath: "tools/bash.mjs",
    });
  });

  it("materializes web_search from the compiled kernel plan", async () => {
    const manifest = createCompiledAgentManifest({
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
      kernelPlan: { prepared: ["web_search"] },
      webSearchProvider: {
        logicalPath: "tools/web_search.ts",
        provider: "exa",
        sourceId: "test:kernel-web-search",
        sourceKind: "module",
      },
    });

    const graph = await resolveRuntimeAgentGraph({
      manifest,
      moduleMap: {
        nodes: {
          [ROOT_COMPILED_AGENT_NODE_ID]: {
            modules: {},
          },
        },
      },
    });

    expect(
      createNodeHarnessTools({ kernelPlan: graph.root.agent.kernelPlan, node: graph.root }).has(
        "web_search",
      ),
    ).toBe(true);
  });

  it("omits web_search when the compiled kernel plan omits it", async () => {
    const manifest = createCompiledAgentManifest({
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
      kernelPlan: { prepared: [] },
    });

    const graph = await resolveRuntimeAgentGraph({
      manifest,
      moduleMap: {
        nodes: {
          [ROOT_COMPILED_AGENT_NODE_ID]: {
            modules: {},
          },
        },
      },
    });

    expect(
      createNodeHarnessTools({ kernelPlan: graph.root.agent.kernelPlan, node: graph.root }).has(
        "web_search",
      ),
    ).toBe(false);
  });

  it("replaces the framework web_search when an authored tool overrides it", async () => {
    const manifest = createCompiledAgentManifest({
      kernelPlan: { prepared: [] },
      agentRoot: "/app/agent",
      appRoot: "/app",
      bindings: [
        TEST_COMPILED_AGENT_CONFIG_BINDING,
        { logicalPath: "tools/web_search.mjs", sourceId: "tools/web_search.mjs" },
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
          description: "Custom web search.",
          inputSchema: null,
          logicalPath: "tools/web_search.mjs",
          name: "web_search",
          sourceId: "tools/web_search.mjs",
          sourceKind: "module",
        },
      ],
    });
    const moduleMap: CompiledModuleMap = {
      nodes: {
        [ROOT_COMPILED_AGENT_NODE_ID]: {
          modules: {
            "tools/web_search.mjs": {
              default: {
                description: "Custom web search.",
                execute(input: unknown) {
                  return input;
                },
                name: "web_search",
              },
            },
          },
        },
      },
    };

    const graph = await resolveRuntimeAgentGraph({ manifest, moduleMap });

    expect(graph.root.turnAgent.tools.find((t) => t.name === "web_search")).toMatchObject({
      description: "Custom web search.",
      kind: "authored-tool",
      name: "web_search",
    });
  });

  it("accepts a compiled manifest with no ordinary tools and preserves native defaults", async () => {
    const manifest = createCompiledAgentManifest({
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
    });

    const graph = await resolveRuntimeAgentGraph({
      manifest,
      moduleMap: {
        nodes: {
          [ROOT_COMPILED_AGENT_NODE_ID]: {
            modules: {},
          },
        },
      },
    });

    expect(graph.root.turnAgent.tools).toEqual([]);
    expect(
      createNodeHarnessTools({ kernelPlan: graph.root.agent.kernelPlan, node: graph.root }).size,
    ).toBe(2);
  });
});
