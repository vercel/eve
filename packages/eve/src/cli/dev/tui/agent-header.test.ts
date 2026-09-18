import { describe, expect, it } from "vitest";

import type { AgentInfoResult } from "#client/index.js";
import { stripAnsi } from "#cli/ui/terminal-text.js";
import { createTestAgentInfoResult } from "#internal/testing/agent-info-fixture.js";

import { buildAgentHeader } from "./agent-header.js";
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

    expect(plain).toHaveLength(1);
    expect(plain[titleIndex]).toMatch(
      /^☰eve v\d+\.\d+\.\d+ · Weather Agent · Run \/help for commands$/u,
    );
    expect(card).not.toContain("model");
    expect(card).not.toContain("instructions");
    expect(card).not.toContain("⣿");
    expect(lines[0]).toContain(theme.colors.bold("☰eve"));
  });

  it("renders only known fields before agent inspection", () => {
    const theme = createTheme({ color: false, unicode: true });
    const card = buildAgentHeader({
      name: "weather-agent",
      theme,
      width: 120,
    }).join("\n");

    expect(card).toContain("weather-agent");
  });

  it("uses ASCII separators and wordmark when Unicode is disabled", () => {
    const theme = createTheme({ color: true, unicode: false });
    const lines = buildAgentHeader({ info: INFO, theme, width: 120 });

    expect(stripAnsi(lines[0] ?? "")).toMatch(
      /^eve v\d+\.\d+\.\d+ - Weather Agent - Run \/help for commands$/u,
    );
    expect(lines[0]).toContain(theme.colors.dim("Weather Agent"));
    expect(lines[0]).toContain(theme.colors.dim("Run /help for commands"));
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
