import { describe, expect, it } from "vitest";

import { buildFrameworkToolInfo } from "#internal/nitro/routes/agent-info/build-agent-info-response.js";

describe("buildFrameworkToolInfo", () => {
  it("reports the built-in agent action as active and available by default", () => {
    const info = buildFrameworkToolInfo({
      authoredToolNames: new Set(),
      delegationToolNames: new Set(),
      disabledFrameworkToolNames: new Set(),
    });

    expect(info.available.map((tool) => tool.name)).toContain("agent");
    expect(info.framework.find((tool) => tool.name === "agent")).toMatchObject({
      status: "active",
    });
  });

  it("reports the built-in agent action as disabled and unavailable", () => {
    const info = buildFrameworkToolInfo({
      authoredToolNames: new Set(),
      delegationToolNames: new Set(),
      disabledFrameworkToolNames: new Set(["agent"]),
    });

    expect(info.available.map((tool) => tool.name)).not.toContain("agent");
    expect(info.framework.find((tool) => tool.name === "agent")).toMatchObject({
      disabledByAuthor: true,
      status: "disabled",
    });
  });

  it("reports a declared agent delegation tool as replacing the recursive action", () => {
    const info = buildFrameworkToolInfo({
      authoredToolNames: new Set(),
      delegationToolNames: new Set(["agent"]),
      disabledFrameworkToolNames: new Set(),
    });

    expect(info.available.map((tool) => tool.name)).not.toContain("agent");
    expect(info.framework.find((tool) => tool.name === "agent")).toMatchObject({
      replacedByAuthoredTool: false,
      status: "replaced",
    });
  });

  it("reports an authored agent tool as replacing the recursive action", () => {
    const info = buildFrameworkToolInfo({
      authoredToolNames: new Set(["agent"]),
      delegationToolNames: new Set(),
      disabledFrameworkToolNames: new Set(),
    });

    expect(info.framework.find((tool) => tool.name === "agent")).toMatchObject({
      replacedByAuthoredTool: true,
      status: "replaced",
    });
  });
});
