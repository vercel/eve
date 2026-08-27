import { describe, expect, it } from "vitest";

import type { AgentInfoResult } from "#client/index.js";
import { stripAnsi } from "#cli/ui/terminal-text.js";
import { createTestAgentInfoResult } from "#internal/testing/agent-info-fixture.js";

import { AGENT_HEADER_TIPS, buildAgentHeader, pickAgentHeaderTip } from "./agent-header.js";
import { createTheme } from "./theme.js";

const INFO = createTestAgentInfoResult({
  agentRoot: "/tmp/weather-agent/agent",
  appRoot: "/tmp/weather-agent",
  modelId: "zai/glm-5.2",
  name: "Weather Agent",
});

describe("buildAgentHeader", () => {
  it("renders a compact agent card", () => {
    const theme = createTheme({ color: true, unicode: true });
    const lines = buildAgentHeader({ info: INFO, theme, width: 120 });
    const plain = lines.map(stripAnsi);
    const card = plain.join("\n");
    const titleIndex = plain.findIndex((line) => line.includes("Weather Agent"));
    const logoIndex = plain.findIndex((line) => line.includes("⣿⣿⣿⣿⣿⣿⣿⣿⣿"));

    expect(plain[0]).toBe(`╭${"─".repeat(66)}╮`);
    expect(plain[titleIndex]).toMatch(/^│ ☰eve \(v\d+\.\d+\.\d+\) +Weather Agent │$/u);
    expect(titleIndex).toBeLessThan(logoIndex);
    expect(card).not.toContain("model");
    expect(card).not.toContain("instructions");
    expect(lines[0]).toBe(theme.colors.dim(plain[0]!));
    expect(lines[logoIndex]).toContain(theme.colors.cyan("⣿⣿⣿⣿⣿⣿⣿⣿⣿    ⠏⣿⣿⣿⣿⣿⣿⣿⣿⣿"));
  });

  it("renders only known fields before agent inspection", () => {
    const theme = createTheme({ color: false, unicode: true });
    const card = buildAgentHeader({
      name: "weather-agent",
      theme,
      tip: "Use the /help command to see every command.",
      width: 120,
    }).join("\n");

    expect(card).toContain("weather-agent");
    expect(card).toContain("Tip: Use the /help command to see every command.");
  });

  it("renders the /add tip with a blue command", () => {
    const theme = createTheme({ color: true, unicode: false });
    const tip = AGENT_HEADER_TIPS.find((candidate) => candidate.includes("/add"));

    expect(tip).toBe("Use the /add command to install an integration.");
    if (tip === undefined) return;

    const line = buildAgentHeader({ info: INFO, theme, width: 120, tip }).at(-1);

    expect(stripAnsi(line ?? "")).toBe(`  Tip: ${tip}`);
    expect(line).toContain(theme.colors.blue("/add"));
  });

  it("keeps the discovery-diagnostics line when the compiler reported problems", () => {
    const theme = createTheme({ color: false, unicode: false });
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
