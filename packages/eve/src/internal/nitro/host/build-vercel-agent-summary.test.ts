import { describe, expect, it } from "vitest";

import {
  type CompiledChannelDefinition,
  type CompiledConnectionDefinition,
  type CompiledScheduleDefinition,
  type CompiledSkillDefinition,
  type CompiledSubagentEdge,
  type CompiledSubagentNode,
  type CompiledToolDefinition,
  createCompiledAgentManifest,
  createCompiledAgentNodeManifest,
  ROOT_COMPILED_AGENT_NODE_ID,
} from "#compiler/manifest.js";
import { buildVercelAgentSummary } from "#internal/nitro/host/build-vercel-agent-summary.js";
import {
  normalizeChannelKindForDisplay,
  VERCEL_EVE_AGENT_SUMMARY_KIND,
  VERCEL_EVE_AGENT_SUMMARY_VERSION,
} from "#internal/vercel-agent-summary.js";

const APP_ROOT = "/app";
const AGENT_ROOT = "/app/agent";
const GENERATOR_VERSION = "0.0.0-test";

function makeTool(name: string): CompiledToolDefinition {
  return {
    description: `${name} description`,
    inputSchema: null,
    logicalPath: `tools/${name}.ts`,
    name,
    sourceId: `tools/${name}.ts`,
    sourceKind: "module",
  };
}

function makeConnection(
  name: string,
  options: {
    vercelConnect?: { connector: string };
    protocol?: CompiledConnectionDefinition["protocol"];
    url?: string;
  } = {},
): CompiledConnectionDefinition {
  const protocol = options.protocol ?? "mcp";
  const base: CompiledConnectionDefinition = {
    connectionName: name,
    description: `${name} description`,
    logicalPath: `connections/${name}.ts`,
    protocol,
    sourceId: `connections/${name}.ts`,
    sourceKind: "module",
    url: options.url ?? `https://mcp.example.com/${name}`,
  };
  if (options.vercelConnect !== undefined) {
    return { ...base, vercelConnect: options.vercelConnect };
  }
  return base;
}

function makeSchedule(name: string, cron: string): CompiledScheduleDefinition {
  return {
    cron,
    hasRun: false,
    logicalPath: `schedules/${name}.md`,
    markdown: `# ${name}`,
    name,
    sourceId: `schedules/${name}.md`,
    sourceKind: "markdown",
  };
}

function makeChannel(input: { name: string; adapterKind?: string }): CompiledChannelDefinition {
  return {
    adapterKind: input.adapterKind,
    kind: "channel",
    logicalPath: `channels/${input.name}.ts`,
    method: "POST",
    name: input.name,
    sourceId: `channels/${input.name}.ts`,
    sourceKind: "module",
    urlPath: `/${input.name}`,
  };
}

function makeFlatSkill(name: string): CompiledSkillDefinition {
  return {
    description: `${name} description`,
    logicalPath: `skills/${name}.md`,
    markdown: `# ${name}`,
    name,
    sourceId: `skills/${name}.md`,
    sourceKind: "markdown",
  };
}

function makePackagedSkill(name: string): CompiledSkillDefinition {
  return {
    description: `${name} description`,
    logicalPath: `skills/${name}`,
    markdown: `# ${name}`,
    name,
    rootPath: `skills/${name}`,
    skillFilePath: `skills/${name}/SKILL.md`,
    skillId: name,
    sourceId: `skills/${name}/SKILL.md`,
    sourceKind: "skill-package",
  };
}

function makeSubagent(name: string): CompiledSubagentNode {
  return {
    agent: createCompiledAgentNodeManifest({
      agentRoot: `${AGENT_ROOT}/subagents/${name}`,
      appRoot: APP_ROOT,
      config: {
        model: { id: "openai/gpt-5.4", routing: { kind: "gateway", target: "openai" } },
        name,
      },
    }),
    description: `${name} subagent description`,
    entryPath: `subagents/${name}/agent.ts`,
    exportName: undefined,
    logicalPath: `subagents/${name}`,
    name,
    nodeId: name,
    rootPath: `subagents/${name}`,
    sourceId: `subagents/${name}/agent.ts`,
    sourceKind: "module",
  };
}

describe("buildVercelAgentSummary", () => {
  it("produces the public summary shape from a compiled manifest", () => {
    const subagent = makeSubagent("research");
    const subagentEdge: CompiledSubagentEdge = {
      childNodeId: "research",
      parentNodeId: ROOT_COMPILED_AGENT_NODE_ID,
    };
    const manifest = createCompiledAgentManifest({
      agentRoot: AGENT_ROOT,
      appRoot: APP_ROOT,
      channels: [
        makeChannel({ name: "slack", adapterKind: "slack" }),
        makeChannel({ name: "weather-bot", adapterKind: "weather-slack" }),
        makeChannel({ name: "messages", adapterKind: "http" }),
        makeChannel({ name: "stripe", adapterKind: "stripe-webhook" }),
        makeChannel({ name: "mystery" }),
        { kind: "disabled", logicalPath: "channels/disabled.ts", name: "disabled" },
      ],
      config: {
        description: "An agent for tests.",
        model: { id: "openai/gpt-5.4", routing: { kind: "gateway", target: "openai" } },
        name: "test-agent",
      },
      connections: [
        makeConnection("linear", {
          vercelConnect: { connector: "oauth/mcp-linear-app" },
        }),
        makeConnection("github"),
        makeConnection("notion-api", {
          protocol: "openapi",
          url: "https://api.notion.com",
        }),
      ],
      diagnosticsSummary: { errors: 0, warnings: 2 },
      schedules: [
        makeSchedule("morning-digest", "0 9 * * *"),
        makeSchedule("weekly-report", "0 9 * * MON"),
      ],
      skills: [makeFlatSkill("get-weather"), makePackagedSkill("research")],
      subagentEdges: [subagentEdge],
      subagents: [subagent],
      instructions: {
        logicalPath: "instructions.md",
        markdown: "You are a helpful test agent. Always cite tools you use.",
        name: "instructions",
        sourceId: "instructions.md",
        sourceKind: "markdown",
      },
      tools: [makeTool("get-weather"), makeTool("send-slack")],
    });

    const summary = buildVercelAgentSummary({
      generatorVersion: GENERATOR_VERSION,
      manifest,
    });

    expect(summary.kind).toBe(VERCEL_EVE_AGENT_SUMMARY_KIND);
    expect(summary.schemaVersion).toBe(VERCEL_EVE_AGENT_SUMMARY_VERSION);
    expect(summary.generatorVersion).toBe(GENERATOR_VERSION);

    expect(summary.agent).toEqual({
      description: "An agent for tests.",
      modelId: "openai/gpt-5.4",
      name: "test-agent",
    });

    expect(summary.instructions).toEqual({
      logicalPath: "instructions.md",
      markdown: "You are a helpful test agent. Always cite tools you use.",
      sourceKind: "markdown",
    });

    expect(summary.tools).toEqual([
      {
        description: "get-weather description",
        logicalPath: "tools/get-weather.ts",
        name: "get-weather",
      },
      {
        description: "send-slack description",
        logicalPath: "tools/send-slack.ts",
        name: "send-slack",
      },
    ]);

    // Skills surface name + description + sourceKind so the dashboard can
    // tell flat markdown skills apart from packaged ones with sibling
    // assets/references/scripts. Full markdown body is intentionally not
    // included — overview shape only.
    expect(summary.skills).toEqual([
      {
        description: "get-weather description",
        logicalPath: "skills/get-weather.md",
        name: "get-weather",
        sourceKind: "markdown",
      },
      {
        description: "research description",
        logicalPath: "skills/research",
        name: "research",
        sourceKind: "skill-package",
      },
    ]);

    expect(summary.connections).toEqual([
      {
        description: "linear description",
        logicalPath: "connections/linear.ts",
        name: "linear",
        type: "mcp",
        url: "https://mcp.example.com/linear",
        // Connect-backed connections surface the connector identifier
        // so dashboards can deep-link to the matching settings page.
        vercelConnect: { connector: "oauth/mcp-linear-app" },
      },
      {
        // No `vercelConnect` field — github connection is just a raw
        // MCP server, not Connect-backed.
        description: "github description",
        logicalPath: "connections/github.ts",
        name: "github",
        type: "mcp",
        url: "https://mcp.example.com/github",
      },
      {
        // OpenAPI connections report their protocol as the type so the
        // dashboard can distinguish them from MCP servers.
        description: "notion-api description",
        logicalPath: "connections/notion-api.ts",
        name: "notion-api",
        type: "openapi",
        url: "https://api.notion.com",
      },
    ]);

    expect(summary.schedules).toEqual([
      {
        cron: "0 9 * * *",
        logicalPath: "schedules/morning-digest.md",
        name: "morning-digest",
      },
      {
        cron: "0 9 * * MON",
        logicalPath: "schedules/weekly-report.md",
        name: "weekly-report",
      },
    ]);

    // Disabled channels are dropped; remaining channels are normalized to
    // the four-value display type.
    expect(summary.channels).toEqual([
      {
        adapterKind: "slack",
        logicalPath: "channels/slack.ts",
        method: "POST",
        name: "slack",
        type: "slack",
        urlPath: "/slack",
      },
      {
        adapterKind: "weather-slack",
        logicalPath: "channels/weather-bot.ts",
        method: "POST",
        name: "weather-bot",
        type: "slack",
        urlPath: "/weather-bot",
      },
      {
        adapterKind: "http",
        logicalPath: "channels/messages.ts",
        method: "POST",
        name: "messages",
        type: "http",
        urlPath: "/messages",
      },
      {
        adapterKind: "stripe-webhook",
        logicalPath: "channels/stripe.ts",
        method: "POST",
        name: "stripe",
        type: "webhook",
        urlPath: "/stripe",
      },
      {
        logicalPath: "channels/mystery.ts",
        method: "POST",
        name: "mystery",
        type: "unknown",
        urlPath: "/mystery",
      },
    ]);

    expect(summary.sandbox).toBeNull();

    expect(summary.subagents).toEqual([
      {
        description: "research subagent description",
        logicalPath: "subagents/research",
        name: "research",
      },
    ]);

    expect(summary.diagnostics).toEqual({ errors: 0, warnings: 2 });
  });

  it("surfaces the package version when no generatorVersion is given", () => {
    const manifest = createCompiledAgentManifest({
      agentRoot: AGENT_ROOT,
      appRoot: APP_ROOT,
      config: {
        model: { id: "openai/gpt-5.4", routing: { kind: "gateway", target: "openai" } },
        name: "minimal-agent",
      },
    });

    const summary = buildVercelAgentSummary({ manifest });

    expect(typeof summary.generatorVersion).toBe("string");
    expect(summary.generatorVersion.length).toBeGreaterThan(0);
    // Agents without authored instructions explicitly report null so
    // dashboard consumers can render "uses framework default" without
    // having to guess from a missing field.
    expect(summary.instructions).toBeNull();
  });

  it("captures module-backed instructions with their resolved markdown", () => {
    const manifest = createCompiledAgentManifest({
      agentRoot: AGENT_ROOT,
      appRoot: APP_ROOT,
      config: {
        model: { id: "openai/gpt-5.4", routing: { kind: "gateway", target: "openai" } },
        name: "module-instructions-agent",
      },
      instructions: {
        logicalPath: "instructions.ts",
        markdown: "Module-backed instructions rendered at build time.",
        name: "instructions",
        sourceId: "instructions.ts",
        sourceKind: "module",
      },
    });

    const summary = buildVercelAgentSummary({ manifest });

    expect(summary.instructions).toEqual({
      logicalPath: "instructions.ts",
      markdown: "Module-backed instructions rendered at build time.",
      sourceKind: "module",
    });
  });
});

describe("normalizeChannelKindForDisplay", () => {
  it("normalizes well-known kinds to the closed display set", () => {
    expect(normalizeChannelKindForDisplay("slack")).toBe("slack");
    expect(normalizeChannelKindForDisplay("Slack")).toBe("slack");
    expect(normalizeChannelKindForDisplay("weather-slack")).toBe("slack");
    expect(normalizeChannelKindForDisplay("http")).toBe("http");
    expect(normalizeChannelKindForDisplay("HTTP")).toBe("http");
    expect(normalizeChannelKindForDisplay("stripe-webhook")).toBe("webhook");
    expect(normalizeChannelKindForDisplay("WEBHOOK")).toBe("webhook");
    expect(normalizeChannelKindForDisplay("custom-kind")).toBe("unknown");
    expect(normalizeChannelKindForDisplay("")).toBe("unknown");
    expect(normalizeChannelKindForDisplay(undefined)).toBe("unknown");
  });
});

// `emitVercelAgentSummary` is exercised end-to-end by
// `build-application.scenario.test.ts`, which asserts the summary JSON file
// is written under the Vercel Build Output directory. Tier 0 unit tests are
// hermetic and may not perform filesystem I/O.
