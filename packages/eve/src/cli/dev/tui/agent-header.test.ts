import { describe, expect, it } from "vitest";

import type { AgentInfoResult, AgentInfoToolEntry } from "#client/index.js";
import { stripAnsi } from "#cli/ui/terminal-text.js";
import { createTestAgentInfoResult } from "#internal/testing/agent-info-fixture.js";

import { AGENT_HEADER_TIPS, buildAgentHeader, pickAgentHeaderTip } from "./agent-header.js";
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
  owner: { feature: "test", kind: "framework" },
  outputSchema: { type: "object" },
  requiresApproval: false,
  sourceId: "eve:defaults:tools/bash.ts",
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
  owner: { kind: "application" },
  outputSchema: null,
  requiresApproval: false,
  sourceId: "tools/get_weather.ts",
  sourceKind: "module",
};

const TEST_INFO = createTestAgentInfoResult({
  agentRoot: "/tmp/weather-agent/agent",
  appRoot: "/tmp/weather-agent",
  modelId: "anthropic/claude-opus-4.7",
  name: "Weather Agent",
});
const INFO: AgentInfoResult = {
  ...TEST_INFO,
  tools: { dynamic: [], static: [FRAMEWORK_TOOL, AUTHORED_TOOL] },
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

  it("renders the /add tip with a blue command", () => {
    const colorTheme = createTheme({ color: true, unicode: false });
    const tip = AGENT_HEADER_TIPS.find((candidate) => candidate.includes("/add"));

    expect(tip).toBe("Use /add to install integrations from the registry.");
    if (tip === undefined) return;

    const line = buildAgentHeader({
      name: "weather-agent",
      info: INFO,
      theme: colorTheme,
      width: 120,
      tip,
    }).at(-1);

    expect(stripAnsi(line ?? "")).toBe(` ${tip}`);
    expect(line).toContain(colorTheme.colors.blue("/add"));
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
