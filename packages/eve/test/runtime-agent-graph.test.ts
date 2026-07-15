import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createCompiledAgentManifest,
  createCompiledAgentNodeManifest,
  ROOT_COMPILED_AGENT_NODE_ID,
} from "../src/compiler/manifest.js";
import type { CompiledModuleMap } from "../src/compiler/module-map.js";
import { defineAgent } from "../src/public/definitions/agent.js";
import { createNodeHarnessTools } from "../src/execution/node-step.js";
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

describe("resolveRuntimeAgentGraph", () => {
  beforeEach(() => {
    vi.stubEnv("VERCEL", "1");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("defaults agents to the Vercel sandbox backend on hosted Vercel", async () => {
    const manifest = createCompiledAgentManifest({
      agentRoot: "/app/agent",
      appRoot: "/app",
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
            modules: {},
          },
          "subagents/researcher": {
            modules: {},
          },
        },
      },
    });

    expect(graph.root.sandboxRegistry.sandbox?.definition.backend.name).toBe("vercel");
    expect(
      graph.nodesByNodeId.get("subagents/researcher")?.sandboxRegistry.sandbox?.definition.backend
        .name,
    ).toBe("vercel");
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
      instructions: {
        name: "reviewer-instructions",
        logicalPath: "instructions.md",
        markdown: "Review drafts carefully.",
        sourceId: "instructions.md",
        sourceKind: "markdown",
      },
    });
    const researcherDefinition = defineAgent({
      description: "Investigate one task in depth.",
      model: TEST_DEFAULT_MODEL_ID,
    });
    const researcherManifest = createCompiledAgentNodeManifest({
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
      instructions: {
        name: "researcher-instructions",
        logicalPath: "instructions.md",
        markdown: "Investigate one task in depth.",
        sourceId: "instructions.md",
        sourceKind: "markdown",
      },
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
      agentRoot,
      appRoot,
      config: {
        model: {
          id: TEST_DEFAULT_MODEL_ID,
          routing: { kind: "gateway", target: "openai" },
        },
        name: "weather-agent",
      },
      instructions: {
        name: "instructions",
        logicalPath: "instructions.md",
        markdown: "Answer weather questions.",
        sourceId: "instructions.md",
        sourceKind: "markdown",
      },
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
        description:
          "Ask the user a question and wait for their response before continuing. Use this when you need clarification or a choice from the user.",
        kind: "authored-tool",
        name: "ask_question",
      },
      {
        description: "Execute a shell command in the shared workspace environment.",
        kind: "authored-tool",
        name: "bash",
      },
      {
        kind: "authored-tool",
        name: "glob",
      },
      {
        kind: "authored-tool",
        name: "grep",
      },
      {
        kind: "authored-tool",
        name: "read_file",
      },
      {
        kind: "authored-tool",
        name: "write_file",
      },
      {
        kind: "authored-tool",
        name: "todo",
      },
      {
        description: [
          "Fetch a webpage and return its content in the requested format. Use this to retrieve and analyze content from URLs.",
          "",
          "Usage notes:",
          "- The URL must be a fully-formed valid URL starting with http:// or https://",
          "- HTML responses are automatically converted to markdown or plain text based on the requested format",
          '- Format options: "markdown" (default), "text", or "html"',
          "- Default timeout is 30 seconds (max 120 seconds)",
          "- Maximum response size is 5 MB; content is further capped at the shared tool-output budget (50 KB / 2000 lines)",
          "- This tool is read-only and does not modify any files",
        ].join("\n"),
        kind: "authored-tool",
        name: "web_fetch",
      },
      {
        description:
          "Search the web for real-time information. Use this to find up-to-date information about current events, recent developments, or topics that may have changed since the knowledge cutoff.",
        kind: "authored-tool",
        name: "web_search",
      },
      {
        kind: "authored-tool",
        name: "load_skill",
      },
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

    expect(researcherNode?.agent.config.name).toBe("researcher");
    expect(researcherNode?.agent.instructions).toEqual({
      name: "researcher-instructions",
      logicalPath: "instructions.md",
      markdown: "Investigate one task in depth.",
      sourceId: "instructions.md",
      sourceKind: "markdown",
    });
    expect(researcherNode?.turnAgent.tools).toMatchObject([
      {
        description:
          "Ask the user a question and wait for their response before continuing. Use this when you need clarification or a choice from the user.",
        kind: "authored-tool",
        name: "ask_question",
      },
      {
        description: "Execute a shell command in the shared workspace environment.",
        kind: "authored-tool",
        name: "bash",
      },
      {
        kind: "authored-tool",
        name: "glob",
      },
      {
        kind: "authored-tool",
        name: "grep",
      },
      {
        kind: "authored-tool",
        name: "read_file",
      },
      {
        kind: "authored-tool",
        name: "write_file",
      },
      {
        kind: "authored-tool",
        name: "todo",
      },
      {
        description: [
          "Fetch a webpage and return its content in the requested format. Use this to retrieve and analyze content from URLs.",
          "",
          "Usage notes:",
          "- The URL must be a fully-formed valid URL starting with http:// or https://",
          "- HTML responses are automatically converted to markdown or plain text based on the requested format",
          '- Format options: "markdown" (default), "text", or "html"',
          "- Default timeout is 30 seconds (max 120 seconds)",
          "- Maximum response size is 5 MB; content is further capped at the shared tool-output budget (50 KB / 2000 lines)",
          "- This tool is read-only and does not modify any files",
        ].join("\n"),
        kind: "authored-tool",
        name: "web_fetch",
      },
      {
        description:
          "Search the web for real-time information. Use this to find up-to-date information about current events, recent developments, or topics that may have changed since the knowledge cutoff.",
        kind: "authored-tool",
        name: "web_search",
      },
      {
        kind: "authored-tool",
        name: "load_skill",
      },
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
    expect(reviewerNode?.agent.instructions).toEqual({
      name: "reviewer-instructions",
      logicalPath: "instructions.md",
      markdown: "Review drafts carefully.",
      sourceId: "instructions.md",
      sourceKind: "markdown",
    });
  });

  it("resolves remote subagents from the owning node manifest only", async () => {
    const appRoot = "/app";
    const agentRoot = "/app/agent";
    const researcherRoot = "/app/agent/subagents/researcher";
    const researcherManifest = createCompiledAgentNodeManifest({
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
      agentRoot,
      appRoot,
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
      agentRoot,
      appRoot: "/app",
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

  it("lets an authored tool replace a framework tool by name collision", async () => {
    const manifest = createCompiledAgentManifest({
      agentRoot: "/app/agent",
      appRoot: "/app",
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
    expect(tools.map((tool) => tool.name)).toEqual([
      "ask_question",
      "glob",
      "grep",
      "read_file",
      "write_file",
      "todo",
      "web_fetch",
      "web_search",
      "load_skill",
      "bash",
    ]);
  });

  it("removes a framework tool when listed in disabledFrameworkTools", async () => {
    const manifest = createCompiledAgentManifest({
      agentRoot: "/app/agent",
      appRoot: "/app",
      config: {
        model: {
          id: TEST_DEFAULT_MODEL_ID,
          routing: { kind: "gateway", target: "openai" },
        },
        name: "weather-agent",
      },
      disabledFrameworkTools: ["web_fetch"],
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

    expect(graph.root.turnAgent.tools.map((tool) => tool.name)).toEqual([
      "ask_question",
      "bash",
      "glob",
      "grep",
      "read_file",
      "write_file",
      "todo",
      "web_search",
      "load_skill",
    ]);
  });

  it("accepts the runtime-owned agent tool in disabledFrameworkTools", async () => {
    const manifest = createCompiledAgentManifest({
      agentRoot: "/app/agent",
      appRoot: "/app",
      config: {
        model: {
          id: TEST_DEFAULT_MODEL_ID,
          routing: { kind: "gateway", target: "openai" },
        },
        name: "weather-agent",
      },
      disabledFrameworkTools: ["agent"],
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

    expect(graph.root.agent.disabledFrameworkTools).toContain("agent");
    expect(createNodeHarnessTools({ node: graph.root }).has("agent")).toBe(false);
  });

  it("combines replacement and disable in one agent", async () => {
    const manifest = createCompiledAgentManifest({
      agentRoot: "/app/agent",
      appRoot: "/app",
      config: {
        model: {
          id: TEST_DEFAULT_MODEL_ID,
          routing: { kind: "gateway", target: "openai" },
        },
        name: "weather-agent",
      },
      disabledFrameworkTools: ["web_fetch"],
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

    expect(tools.map((tool) => tool.name)).toEqual([
      "ask_question",
      "glob",
      "grep",
      "read_file",
      "write_file",
      "todo",
      "web_search",
      "load_skill",
      "bash",
    ]);
    expect(tools.find((tool) => tool.name === "bash")).toMatchObject({
      description: "Sandboxed shell.",
      logicalPath: "tools/bash.mjs",
    });
  });

  it("includes web_search as a default framework tool", async () => {
    const manifest = createCompiledAgentManifest({
      agentRoot: "/app/agent",
      appRoot: "/app",
      config: {
        model: {
          id: TEST_DEFAULT_MODEL_ID,
          routing: { kind: "gateway", target: "openai" },
        },
        name: "weather-agent",
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

    expect(graph.root.turnAgent.tools.map((t) => t.name)).toContain("web_search");
  });

  it("removes web_search when listed in disabledFrameworkTools", async () => {
    const manifest = createCompiledAgentManifest({
      agentRoot: "/app/agent",
      appRoot: "/app",
      config: {
        model: {
          id: TEST_DEFAULT_MODEL_ID,
          routing: { kind: "gateway", target: "openai" },
        },
        name: "weather-agent",
      },
      disabledFrameworkTools: ["web_search"],
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

    expect(graph.root.turnAgent.tools.map((t) => t.name)).not.toContain("web_search");
  });

  it("replaces the framework web_search when an authored tool overrides it", async () => {
    const manifest = createCompiledAgentManifest({
      agentRoot: "/app/agent",
      appRoot: "/app",
      config: {
        model: {
          id: TEST_DEFAULT_MODEL_ID,
          routing: { kind: "gateway", target: "openai" },
        },
        name: "weather-agent",
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

  it("throws when disabledFrameworkTools references an unknown framework tool", async () => {
    const manifest = createCompiledAgentManifest({
      agentRoot: "/app/agent",
      appRoot: "/app",
      config: {
        model: {
          id: TEST_DEFAULT_MODEL_ID,
          routing: { kind: "gateway", target: "openai" },
        },
        name: "weather-agent",
      },
      disabledFrameworkTools: ["nonexistent_tool"],
    });

    await expect(
      resolveRuntimeAgentGraph({
        manifest,
        moduleMap: {
          nodes: {
            [ROOT_COMPILED_AGENT_NODE_ID]: {
              modules: {},
            },
          },
        },
      }),
    ).rejects.toThrow(
      /agent\/tools\/nonexistent_tool\.ts exports disableTool\(\) but "nonexistent_tool" is not a framework tool/,
    );
  });
});
