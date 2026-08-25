import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createCompiledAgentResources,
  createCompiledAgentManifest,
  createCompiledAgentNodeManifest,
  ROOT_COMPILED_AGENT_NODE_ID,
  type CreateCompiledAgentResourcesInput,
} from "../src/compiler/manifest.js";
import type { CompiledModuleMap } from "../src/compiler/module-map.js";
import {
  EMPTY_CHANNEL_ROUTE_PLAN,
  EMPTY_SOURCE_COMPOSITION,
  testCompiledSandbox,
  testSandboxModuleNamespace,
} from "../src/internal/testing/compiled-node-fixtures.js";
import { defineAgent } from "../src/public/definitions/agent.js";
import { defineDynamic } from "../src/public/definitions/tool.js";
import { TEST_DEFAULT_MODEL_ID } from "../src/internal/testing/app-harness.js";
import { ROOT_RUNTIME_AGENT_NODE_ID } from "../src/runtime/graph.js";
import { resolveRuntimeAgentGraph } from "../src/runtime/resolve-agent-graph.js";

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

const TEST_SANDBOX = testCompiledSandbox();

function baseNodeInput(): Pick<
  CreateCompiledAgentResourcesInput,
  "bindings" | "sandbox" | "sourceComposition"
> {
  return {
    bindings: {},
    sandbox: TEST_SANDBOX,
    sourceComposition: EMPTY_SOURCE_COMPOSITION,
  };
}

/** Module namespaces every hand-built node needs: its compiled sandbox. */
function sandboxModules(): Record<string, Record<string, unknown>> {
  return { [TEST_SANDBOX.sourceId]: testSandboxModuleNamespace() };
}

describe("resolveRuntimeAgentGraph", () => {
  beforeEach(() => {
    vi.stubEnv("VERCEL", "1");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("defaults agents to the Vercel sandbox backend on hosted Vercel", async () => {
    const manifest = createCompiledAgentManifest({
      ...baseNodeInput(),
      agentRoot: "/app/agent",
      appRoot: "/app",
      channelRoutes: EMPTY_CHANNEL_ROUTE_PLAN,
      config: {
        model: {
          id: TEST_DEFAULT_MODEL_ID,
          routing: { kind: "gateway", target: "openai" },
        },
        name: "workspace-agent",
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
          agent: createCompiledAgentNodeManifest({
            ...baseNodeInput(),
            agentRoot: "/app/agent/subagents/researcher",
            appRoot: "/app",
            config: {
              description: "Investigate one task in depth.",
              model: {
                id: TEST_DEFAULT_MODEL_ID,
                routing: { kind: "gateway", target: "openai" },
              },
              name: "researcher",
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
          }),
          description: "Investigate one task in depth.",
          entryPath: "/app/agent/subagents/researcher",
          logicalPath: "subagents/researcher",
          name: "researcher",
          nodeId: "subagents/researcher",
          rootPath: "/app/agent/subagents/researcher",
          sourceId: "subagents/researcher",
          sourceKind: "module",
        },
      ],
    });
    const graph = await resolveRuntimeAgentGraph({
      manifest,
      moduleMap: {
        nodes: {
          [ROOT_COMPILED_AGENT_NODE_ID]: {
            modules: sandboxModules(),
          },
          "subagents/researcher": {
            modules: sandboxModules(),
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
      ...baseNodeInput(),
      agentRoot: "/app/agent",
      appRoot: "/app",
      channelRoutes: EMPTY_CHANNEL_ROUTE_PLAN,
      config: {
        model: {
          id: TEST_DEFAULT_MODEL_ID,
          routing: { kind: "gateway", target: "openai" },
        },
        name: "root",
      },
      subagentEdges: [
        {
          childNodeId: "subagents/researcher",
          parentNodeId: ROOT_COMPILED_AGENT_NODE_ID,
        },
      ],
      subagents: [
        {
          agent: createCompiledAgentResources({
            ...baseNodeInput(),
            agentRoot: "/app/agent/subagents/researcher",
            appRoot: "/app",
          }),
          configResolver: {
            eventNames: ["session.started"],
            logicalPath: "agent.ts",
            sourceId: "agent.ts",
            sourceKind: "module",
          },
          entryPath: "/app/agent/subagents/researcher/agent.ts",
          logicalPath: "subagents/researcher",
          name: "researcher",
          nodeId: "subagents/researcher",
          rootPath: "/app/agent/subagents/researcher",
          sourceId: "subagents/researcher",
          sourceKind: "module",
        },
      ],
    });

    const graph = await resolveRuntimeAgentGraph({
      manifest,
      moduleMap: {
        nodes: {
          [ROOT_COMPILED_AGENT_NODE_ID]: { modules: sandboxModules() },
          "subagents/researcher": {
            modules: {
              ...sandboxModules(),
              "agent.ts": { default: dynamic },
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
        name: "researcher",
        nodeId: "subagents/researcher",
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
    const reviewerManifest = createCompiledAgentNodeManifest({
      ...baseNodeInput(),
      agentRoot: reviewerRoot,
      appRoot,
      config: {
        description: reviewerDefinition.description,
        model: {
          id: TEST_DEFAULT_MODEL_ID,
          routing: { kind: "gateway", target: "openai" },
        },
        name: "reviewer",
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
    });
    const researcherDefinition = defineAgent({
      description: "Investigate one task in depth.",
      model: TEST_DEFAULT_MODEL_ID,
    });
    const researcherManifest = createCompiledAgentNodeManifest({
      ...baseNodeInput(),
      agentRoot: researcherRoot,
      appRoot,
      config: {
        description: researcherDefinition.description,
        model: {
          id: TEST_DEFAULT_MODEL_ID,
          routing: { kind: "gateway", target: "openai" },
        },
        name: "researcher",
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
    });
    const manifest = createCompiledAgentManifest({
      ...baseNodeInput(),
      agentRoot,
      appRoot,
      channelRoutes: EMPTY_CHANNEL_ROUTE_PLAN,
      config: {
        model: {
          id: TEST_DEFAULT_MODEL_ID,
          routing: { kind: "gateway", target: "openai" },
        },
        name: "weather-agent",
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
          description: researcherDefinition.description!,
          entryPath: researcherRoot,
          logicalPath: "subagents/researcher",
          name: "researcher",
          nodeId: "subagents/researcher",
          rootPath: researcherRoot,
          sourceId: "subagents/researcher",
          sourceKind: "module",
        },
        {
          agent: reviewerManifest,
          description: reviewerDefinition.description!,
          entryPath: reviewerRoot,
          logicalPath: "subagents/reviewer",
          name: "reviewer",
          nodeId: "subagents/researcher::subagents/reviewer",
          rootPath: reviewerRoot,
          sourceId: "subagents/reviewer",
          sourceKind: "module",
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
            ...sandboxModules(),
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
            ...sandboxModules(),
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
          modules: sandboxModules(),
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
    // Only compiled rows resolve: framework tools appear at runtime only when
    // the compiled manifest carries their rows.
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
    const researcherManifest = createCompiledAgentNodeManifest({
      ...baseNodeInput(),
      agentRoot: researcherRoot,
      appRoot,
      config: {
        description: "Investigate one task in depth.",
        model: {
          id: TEST_DEFAULT_MODEL_ID,
          routing: { kind: "gateway", target: "openai" },
        },
        name: "researcher",
      },
      remoteAgents: [
        {
          description: "Answer niche follow-up questions remotely.",
          entryPath: `${researcherRoot}/subagents/qux.ts`,
          logicalPath: "subagents/qux.ts",
          name: "qux",
          nodeId: "subagents/qux.ts",
          path: "/eve/v1/session",
          rootPath: researcherRoot,
          sourceId: "subagents/qux.ts",
          sourceKind: "module",
          url: "https://qux.example.com",
        },
      ],
    });
    const manifest = createCompiledAgentManifest({
      ...baseNodeInput(),
      agentRoot,
      appRoot,
      channelRoutes: EMPTY_CHANNEL_ROUTE_PLAN,
      config: {
        model: {
          id: TEST_DEFAULT_MODEL_ID,
          routing: { kind: "gateway", target: "openai" },
        },
        name: "router",
      },
      remoteAgents: [
        {
          description: "Answer weather questions remotely.",
          entryPath: `${agentRoot}/subagents/weather.ts`,
          logicalPath: "subagents/weather.ts",
          name: "weather",
          nodeId: "subagents/weather.ts",
          path: "/eve/v1/session",
          rootPath: agentRoot,
          sourceId: "subagents/weather.ts",
          sourceKind: "module",
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
          agent: researcherManifest,
          description: "Investigate one task in depth.",
          entryPath: researcherRoot,
          logicalPath: "subagents/researcher",
          name: "researcher",
          nodeId: "subagents/researcher",
          rootPath: researcherRoot,
          sourceId: "subagents/researcher",
          sourceKind: "module",
        },
      ],
    });
    const graph = await resolveRuntimeAgentGraph({
      manifest,
      moduleMap: {
        nodes: {
          [ROOT_COMPILED_AGENT_NODE_ID]: {
            modules: {
              ...sandboxModules(),
              "subagents/weather.ts": {
                default: {
                  description: "Answer weather questions remotely.",
                  kind: "remote",
                  path: "/eve/v1/session",
                  url: () => "https://weather.example.com",
                },
              },
            },
          },
          "subagents/researcher": {
            modules: {
              ...sandboxModules(),
              "subagents/qux.ts": {
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
      logicalPath: "subagents/weather.ts",
      name: "weather",
      nodeId: "subagents/weather.ts",
    });
    expect(rootRemote?.definition).toMatchObject({
      kind: "remote",
      url: "https://weather.example.com",
    });
    expect(nestedRemote?.prepared).toMatchObject({
      kind: "remote",
      logicalPath: "subagents/qux.ts",
      name: "qux",
      nodeId: "subagents/qux.ts",
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
      ...baseNodeInput(),
      agentRoot,
      appRoot: "/app",
      channelRoutes: EMPTY_CHANNEL_ROUTE_PLAN,
      config: {
        model: {
          id: TEST_DEFAULT_MODEL_ID,
          routing: { kind: "gateway", target: "openai" },
        },
        name: "router",
      },
      remoteAgents: [
        {
          description: "Answer weather questions remotely.",
          entryPath: `${agentRoot}/subagents/weather.ts`,
          logicalPath: "subagents/weather.ts",
          name: "weather",
          nodeId: "subagents/weather.ts",
          path: "/eve/v1/session",
          rootPath: agentRoot,
          sourceId: "subagents/weather.ts",
          sourceKind: "module",
        },
      ],
    });
    const graph = await resolveRuntimeAgentGraph({
      manifest,
      moduleMap: {
        nodes: {
          [ROOT_COMPILED_AGENT_NODE_ID]: {
            modules: {
              ...sandboxModules(),
              "subagents/weather.ts": {
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

  // Framework tool merging, disablement, and replacement are decided by
  // source composition at compile time. The runtime resolves only the rows
  // the compiled manifest carries — a lone application-owned "bash" row is
  // an ordinary authored tool, and no framework merge introduces siblings.
  it("registers only compiled tool rows without merging framework defaults", async () => {
    const manifest = createCompiledAgentManifest({
      ...baseNodeInput(),
      agentRoot: "/app/agent",
      appRoot: "/app",
      bindings: {
        "tools/bash.mjs": {
          backing: {
            externalDependencies: [],
            kind: "filesystem",
            sourcePath: "/app/agent/tools/bash.mjs",
          },
          logicalPath: "tools/bash.mjs",
          owner: { kind: "application" },
        },
      },
      channelRoutes: EMPTY_CHANNEL_ROUTE_PLAN,
      config: {
        model: {
          id: TEST_DEFAULT_MODEL_ID,
          routing: { kind: "gateway", target: "openai" },
        },
        name: "weather-agent",
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
            ...sandboxModules(),
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

    expect(tools.map((tool) => tool.name)).toEqual(["bash"]);
    expect(tools[0]).toMatchObject({
      description: "Run a vetted shell command in the project sandbox.",
      kind: "authored-tool",
      logicalPath: "tools/bash.mjs",
      name: "bash",
      owner: { kind: "application" },
    });
  });
});
