import { describe, expect, it } from "vitest";

import { assertSingleEveVersion } from "#internal/vercel/assemble-eve-services.js";

const target = { hostOutputDirectory: "/project/.vercel/output", projectRoot: "/project" };

function agent(name: string) {
  return {
    agent: {
      appRoot: `/project/agents/${name}`,
      buildCommand: "eve build",
      name,
      publicRoutePrefix: `/eve/${name}`,
      workspaceMember: true,
    },
    target,
  };
}

describe("assertSingleEveVersion", () => {
  it("accepts agents that resolve the project's eve version", () => {
    expect(() =>
      assertSingleEveVersion([agent("support"), agent("billing")], () => "1.4.0"),
    ).not.toThrow();
  });

  it("ignores roots where eve does not resolve", () => {
    const versions: Record<string, string> = { "/project/agents/support": "1.4.0" };
    expect(() =>
      assertSingleEveVersion([agent("support"), agent("billing")], (root) => versions[root]),
    ).not.toThrow();
  });

  it("rejects an agent that resolves a different eve version", () => {
    const versions: Record<string, string> = {
      "/project": "1.4.0",
      "/project/agents/support": "1.4.0",
      "/project/agents/billing": "1.2.0",
    };
    expect(() =>
      assertSingleEveVersion([agent("support"), agent("billing")], (root) => versions[root]),
    ).toThrow(
      "Every eve agent in one Vercel deployment must resolve the same eve version, found eve@1.4.0 in ., agents/support; eve@1.2.0 in agents/billing.",
    );
  });

  it("rejects a standalone agent whose eve differs from the project's", () => {
    const versions: Record<string, string> = {
      "/project": "1.4.0",
      "/project/agents/support": "1.2.0",
    };
    expect(() => assertSingleEveVersion([agent("support")], (root) => versions[root])).toThrow(
      "found eve@1.4.0 in .; eve@1.2.0 in agents/support.",
    );
  });
});
