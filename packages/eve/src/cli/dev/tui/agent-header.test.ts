import { describe, expect, it } from "vitest";

import type { AgentInfoResult, AgentInfoToolEntry } from "#client/index.js";

import { AGENT_HEADER_TIPS, buildAgentHeader, pickAgentHeaderTip } from "./agent-header.js";
import { stripAnsi } from "./terminal-text.js";
import { createTheme } from "./theme.js";

const FRAMEWORK_TOOL: AgentInfoToolEntry = {
  description: "Run a shell command.",
  hasAuth: false,
  hasExecute: true,
  hasModelOutputProjection: false,
  hasOutputSchema: true,
  inputSchema: { type: "object" },
  logicalPath: "eve:framework/bash",
  name: "bash",
  origin: "framework",
  outputSchema: { type: "object" },
  replacesFrameworkTool: false,
  requiresApproval: false,
  sourceId: "eve:bash-tool",
  sourceKind: "module",
};

const AUTHORED_TOOL: AgentInfoToolEntry = {
  description: "Get the weather.",
  hasAuth: false,
  hasExecute: true,
  hasModelOutputProjection: false,
  hasOutputSchema: false,
  inputSchema: { type: "object" },
  logicalPath: "agent/tools/get_weather.ts",
  name: "get_weather",
  origin: "authored",
  outputSchema: null,
  replacesFrameworkTool: false,
  requiresApproval: false,
  sourceKind: "module",
};

const INFO: AgentInfoResult = {
  agent: {
    agentRoot: "/tmp/weather-agent/agent",
    appRoot: "/tmp/weather-agent",
    model: {
      id: "anthropic/claude-opus-4.7",
    },
    name: "Weather Agent",
  },
  capabilities: {
    devRoutes: true,
  },
  channels: {
    authored: [],
    available: [],
    disabledFramework: [],
    framework: [],
  },
  connections: [],
  diagnostics: {
    discoveryErrors: 0,
    discoveryWarnings: 0,
  },
  hooks: [],
  instructions: {
    dynamic: [],
    static: {
      logicalPath: "instructions.md",
      markdown: "You are a weather assistant.",
      name: "instructions",
      sourceKind: "markdown",
    },
  },
  kind: "eve-agent-info",
  mode: "development",
  sandbox: null,
  schedules: [],
  skills: {
    dynamic: [],
    static: [],
  },
  subagents: {
    local: [],
    total: 0,
  },
  tools: {
    authored: [AUTHORED_TOOL],
    available: [FRAMEWORK_TOOL, AUTHORED_TOOL],
    disabledFramework: [],
    dynamic: [],
    framework: [
      {
        ...FRAMEWORK_TOOL,
        disabledByAuthor: false,
        replacedByAuthoredTool: false,
        status: "active",
      },
    ],
    reserved: [],
  },
  version: 1,
  workflow: {
    enabled: false,
    toolName: "Workflow",
  },
  workspace: {
    resourceRoot: null,
    rootEntries: [],
  },
};

describe("buildAgentHeader", () => {
  const theme = createTheme({ color: false, unicode: false });

  it("renders the brand line with the agent name", () => {
    const lines = buildAgentHeader({ name: "agent-subagents", info: INFO, theme, width: 120 });

    expect(lines).toEqual([" eve agent-subagents"]);
  });

  it("renders just the brand line when info is unavailable", () => {
    expect(buildAgentHeader({ name: "weather-agent", theme, width: 120 })).toEqual([
      " eve weather-agent",
    ]);
  });

  it("renders the tip line for local sessions only", () => {
    const tip = AGENT_HEADER_TIPS[0]!;
    const local = buildAgentHeader({ name: "weather-agent", info: INFO, theme, width: 120, tip });
    expect(local).toEqual([" eve weather-agent", ` ${tip}`]);

    const remote = buildAgentHeader({ name: "weather-agent", info: INFO, theme, width: 120 });
    expect(remote.join("\n")).not.toContain("/channels");
  });

  it("renders the /connect tip with a blue command", () => {
    const colorTheme = createTheme({ color: true, unicode: false });
    const tip = AGENT_HEADER_TIPS.find((candidate) => candidate.includes("/connect"));

    expect(tip).toBe("Tip: /connect to seamlessly add MCP Connections to your agent");
    if (tip === undefined) return;

    const line = buildAgentHeader({
      name: "weather-agent",
      info: INFO,
      theme: colorTheme,
      width: 120,
      tip,
    }).at(-1);

    expect(stripAnsi(line ?? "")).toBe(` ${tip}`);
    expect(line).toContain(colorTheme.colors.blue("/connect"));
  });

  it("keeps the discovery-diagnostics line when the compiler reported problems", () => {
    const info: AgentInfoResult = {
      ...INFO,
      diagnostics: { discoveryErrors: 1, discoveryWarnings: 2 },
    };
    const lines = buildAgentHeader({ name: "weather-agent", info, theme, width: 120 });

    expect(lines.some((line) => line.includes("1 error"))).toBe(true);
    expect(lines.some((line) => line.includes("2 warnings"))).toBe(true);
  });
});

describe("pickAgentHeaderTip", () => {
  it("maps the random draw across the whole pool", () => {
    expect(pickAgentHeaderTip(() => 0)).toBe(AGENT_HEADER_TIPS[0]);
    expect(pickAgentHeaderTip(() => 0.999)).toBe(AGENT_HEADER_TIPS.at(-1));
  });
});
