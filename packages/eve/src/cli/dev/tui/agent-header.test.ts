import { describe, expect, it } from "vitest";

import type {
  AgentInfoInstructionsEntry,
  AgentInfoRemoteAgentEntry,
  AgentInfoResult,
  AgentInfoScheduleEntry,
  AgentInfoSkillEntry,
  AgentInfoToolEntry,
} from "#client/index.js";
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

  it("renders the startup card", () => {
    const colorTheme = createTheme({ color: true, unicode: true });
    const info: AgentInfoResult = {
      ...INFO,
      agent: {
        ...INFO.agent,
        model: {
          id: "zai/glm-5.2",
          routing: { kind: "gateway", target: "zai" },
          endpoint: { kind: "gateway", connected: true, credential: "api-key" },
        },
      },
    };
    const lines = buildAgentHeader({ info, theme: colorTheme, width: 120 });
    const plain = lines.map(stripAnsi);

    const card = plain.join("\n");
    const titleIndex = plain.findIndex((line) => line.includes("Weather Agent"));
    const logoIndex = plain.findIndex((line) => line.includes("⣿⣿⣿⣿⣿⣿⣿⣿⣿"));
    const modelIndex = plain.findIndex((line) => line.includes("model"));

    expect(plain[0]).toBe(`╭${"─".repeat(66)}╮`);
    expect(plain[titleIndex]).toMatch(/^│ ☰eve \(v\d+\.\d+\.\d+\) +Weather Agent │$/u);
    expect(titleIndex).toBeLessThan(logoIndex);
    expect(logoIndex).toBeLessThan(modelIndex);
    expect(card).toContain("model         zai/glm-5.2 via ai-gateway(api-key)");
    expect(card).toContain("instructions  none");
    expect(card).toContain("agent       get_weather");
    expect(card).toContain("eve         bash");
    expect(card).toContain("skills        none");
    expect(card).toContain("subagents     none");
    expect(card).toContain("schedules     none");
    expect(plain.at(-2)).toContain("schedules     none");
    expect(lines[0]).toBe(colorTheme.colors.dim(plain[0]!));
    expect(lines[logoIndex]).toContain(colorTheme.colors.cyan("⣿⣿⣿⣿⣿⣿⣿⣿⣿    ⠏⣿⣿⣿⣿⣿⣿⣿⣿⣿"));
    expect(lines[modelIndex]).toContain(colorTheme.colors.dim("via "));
  });

  it("renders only known fields while the agent is loading", () => {
    const colorTheme = createTheme({ color: true, unicode: true });
    const card = buildAgentHeader({
      name: "weather-agent",
      theme: colorTheme,
      tip: "Use the /help command to see every command.",
      width: 120,
    })
      .map(stripAnsi)
      .join("\n");

    expect(card).toContain("weather-agent");
    expect(card).toContain("Tip: Use the /help command to see every command.");
    expect(card).not.toContain("loading");
    for (const label of [
      "model",
      "instructions",
      "tools",
      "agent",
      "dynamic",
      "skills",
      "subagents",
      "schedules",
    ]) {
      expect(card).not.toMatch(new RegExp(`^│ +${label}`, "mu"));
    }
  });

  it("bounds every collection for large agents", () => {
    const source = (name: string) => ({
      logicalPath: `${name}.ts`,
      owner: { kind: "application" as const },
      sourceId: `${name}.ts`,
      sourceKind: "module" as const,
    });
    const instructions: AgentInfoInstructionsEntry[] = Array.from({ length: 12 }, (_, index) => ({
      ...source(`instructions-${index}`),
      content: "Instructions.",
      name: `instructions-${index}`,
      role: "system",
    }));
    const skills: AgentInfoSkillEntry[] = Array.from({ length: 12 }, (_, index) => ({
      ...source(`skill-${index}`),
      description: "Skill.",
      markdown: "# Skill",
      name: `skill-${index}`,
    }));
    const schedules: AgentInfoScheduleEntry[] = Array.from({ length: 12 }, (_, index) => ({
      ...source(`schedule-${index}`),
      cron: "0 0 * * *",
      hasRun: true,
      name: `schedule-${index}`,
    }));
    const remoteAgents: AgentInfoRemoteAgentEntry[] = Array.from({ length: 12 }, (_, index) => ({
      ...source(`subagent-${index}`),
      description: "Subagent.",
      name: `subagent-${index}`,
      nodeId: `remote-${index}`,
      parentNodeId: "__root__",
    }));
    const extensionTools = Array.from({ length: 6 }, (_, index): AgentInfoToolEntry => ({
      ...AUTHORED_TOOL,
      logicalPath: `extension-${index}/tool.ts`,
      name: `extension_tool_${index}`,
      owner: {
        kind: "extension",
        namespace: `extension-${index}`,
        packageName: `@example/extension-${index}`,
      },
      sourceId: `extension-${index}/tool.ts`,
    }));
    const info: AgentInfoResult = {
      ...INFO,
      instructions: { dynamic: [], static: instructions },
      remoteAgents: { entries: remoteAgents, total: remoteAgents.length },
      schedules,
      skills: { dynamic: [], static: skills },
      tools: { dynamic: [], static: [AUTHORED_TOOL, ...extensionTools, FRAMEWORK_TOOL] },
    };

    const card = buildAgentHeader({ info, theme, width: 120 }).join("\n");

    for (const label of ["instructions", "skills", "subagents", "schedules"]) {
      expect(card.match(new RegExp(`${label}.*\\+\\d+ more`, "u"))).not.toBeNull();
    }
    expect(card).toContain("  +4 groups");
    expect(card).not.toContain("  eve         bash");
  });

  it("renders the /add tip with a blue command", () => {
    const colorTheme = createTheme({ color: true, unicode: false });
    const tip = AGENT_HEADER_TIPS.find((candidate) => candidate.includes("/add"));

    expect(tip).toBe("Use the /add command to install an integration.");
    if (tip === undefined) return;

    const line = buildAgentHeader({
      info: INFO,
      theme: colorTheme,
      width: 120,
      tip,
    }).at(-1);

    expect(stripAnsi(line ?? "")).toBe(`  Tip: ${tip}`);
    expect(line).toContain(colorTheme.colors.blue("/add"));
  });

  it("keeps the discovery-diagnostics line when the compiler reported problems", () => {
    const info: AgentInfoResult = {
      ...INFO,
      diagnostics: { discoveryErrors: 1, discoveryWarnings: 2 },
    };
    const lines = buildAgentHeader({ info, theme, width: 120 });

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
