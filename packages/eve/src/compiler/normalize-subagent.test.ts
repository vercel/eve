import { describe, expect, it } from "vitest";

import { normalizeSubagentConfig } from "#compiler/normalize-subagent.js";
import { createLegacySubagentDefinitionDiagnostic } from "#compiler/diagnostics.js";
import { defineAgent, defineLocalSubagent } from "#public/definitions/agent.js";
import { defineRemoteAgent, defineRemoteSubagent } from "#public/definitions/remote-agent.js";

describe("normalizeSubagentConfig", () => {
  it("provides an actionable legacy migration diagnostic", () => {
    expect(
      createLegacySubagentDefinitionDiagnostic({
        logicalPath: "subagents/researcher",
        nodeId: "__root__",
        sourceId: "subagents/researcher",
      }),
    ).toMatchObject({
      code: "compile/subagent-legacy-definition",
      message: expect.stringContaining("defineLocalSubagent"),
      severity: "warning",
    });
  });
  it("compiles explicit local execution policy outside child config", () => {
    const normalized = normalizeSubagentConfig(
      defineLocalSubagent({
        background: true,
        description: "Research deeply.",
        model: "openai/gpt-5.5",
      }),
      "invalid subagent",
    );

    expect(normalized).toMatchObject({
      definition: { description: "Research deeply.", model: "openai/gpt-5.5" },
      execution: "background",
      kind: "local",
    });
    expect(normalized).not.toHaveProperty("definition.background");
    expect(normalized).not.toHaveProperty("definition.kind");
  });

  it("compiles explicit remote blocking policy", () => {
    expect(
      normalizeSubagentConfig(
        defineRemoteSubagent({
          background: false,
          description: "Review remotely.",
          url: "https://review.example.com",
        }),
        "invalid subagent",
      ),
    ).toMatchObject({ execution: "blocking", kind: "remote" });
  });

  it("leaves legacy helper execution unspecified", () => {
    expect(
      normalizeSubagentConfig(
        defineAgent({ description: "Research.", model: "openai/gpt-5.5" }),
        "invalid subagent",
      ),
    ).toEqual({
      definition: { description: "Research.", model: "openai/gpt-5.5" },
      kind: "local",
    });
    expect(
      normalizeSubagentConfig(
        defineRemoteAgent({
          description: "Review.",
          url: "https://review.example.com",
        }),
        "invalid subagent",
      ),
    ).not.toHaveProperty("execution");
  });

  it("rejects execution policy on the legacy remote helper", () => {
    expect(() =>
      normalizeSubagentConfig(
        {
          background: true,
          description: "Review.",
          kind: "remote",
          path: "/eve/v1/session",
          url: "https://review.example.com",
        },
        "invalid subagent",
      ),
    ).toThrow('The "background" field requires defineRemoteSubagent(...)');
  });
});
