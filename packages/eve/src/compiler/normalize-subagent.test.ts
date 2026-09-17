import { describe, expect, it } from "vitest";

import { normalizeSubagentConfig } from "#compiler/normalize-subagent.js";
import { defineA2AAgent } from "#public/definitions/a2a-agent.js";
import { defineAgent } from "#public/definitions/agent.js";
import { defineRemoteAgent } from "#public/definitions/remote-agent.js";

describe("normalizeSubagentConfig", () => {
  it("normalizes a local agent definition as a subagent", () => {
    const normalized = normalizeSubagentConfig(
      defineAgent({
        description: "Research deeply.",
        model: "openai/gpt-5.5",
      }),
      "Invalid subagent.",
    );

    expect(normalized).toEqual({
      definition: {
        description: "Research deeply.",
        model: "openai/gpt-5.5",
      },
      kind: "local",
    });
  });

  it("preserves a local subagent's tool setting", () => {
    expect(
      normalizeSubagentConfig(
        defineAgent({
          description: "Research deeply.",
          model: "openai/gpt-5.5",
          tool: false,
        }),
        "Invalid subagent.",
      ),
    ).toMatchObject({ definition: { tool: false }, kind: "local" });
  });

  it("compiles A2A metadata without resolving URLs or persisting credentials", () => {
    const url = () => {
      throw new Error("Compilation must not resolve this URL");
    };
    const definition = defineA2AAgent({
      url,
      description: "Plans a trip.",
      auth: {
        getToken: async () => ({ token: "private-token" }),
        vercelConnect: { connector: "travel/planner" },
      },
      headers: { "x-api-key": "private-key" },
    });
    const result = normalizeSubagentConfig(definition, "Invalid A2A subagent");
    expect(result).toMatchObject({
      kind: "remote",
      protocol: "a2a",
      vercelConnect: { connector: "travel/planner" },
    });
    expect(JSON.stringify(result)).not.toContain("private");
    expect(() =>
      defineA2AAgent({
        url: "https://example.com",
        description: "Planner",
        allowedInterfaceOrigins: ["https://example.com/path"],
      }),
    ).toThrow("exact origins");
  });

  it("normalizes a remote subagent", () => {
    expect(
      normalizeSubagentConfig(
        defineRemoteAgent({
          description: "Review remotely.",
          url: "https://review.example.com",
        }),
        "Invalid subagent.",
      ),
    ).toMatchObject({ kind: "remote" });
  });

  it("rejects a non-boolean remote subagent tool setting", () => {
    expect(() =>
      normalizeSubagentConfig(
        {
          description: "Review remotely.",
          kind: "remote",
          tool: "no",
          url: "https://review.example.com",
        },
        "Invalid subagent.",
      ),
    ).toThrow("Invalid subagent.");
  });

  it("preserves a remote subagent's tool setting", () => {
    expect(
      normalizeSubagentConfig(
        defineRemoteAgent({
          description: "Review remotely.",
          tool: false,
          url: "https://review.example.com",
        }),
        "Invalid subagent.",
      ),
    ).toMatchObject({ kind: "remote", tool: false });
  });
});
