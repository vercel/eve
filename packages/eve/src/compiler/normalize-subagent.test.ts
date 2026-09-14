import { describe, expect, it } from "vitest";

import { normalizeSubagentConfig } from "#compiler/normalize-subagent.js";
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
});
