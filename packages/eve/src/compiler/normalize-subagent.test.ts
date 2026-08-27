import { describe, expect, it } from "vitest";

import { normalizeSubagentConfig } from "#compiler/normalize-subagent.js";
import { defineLocalSubagent } from "#public/definitions/agent.js";
import { defineRemoteSubagent } from "#public/definitions/remote-agent.js";

describe("normalizeSubagentConfig", () => {
  it("strips local execution policy from the child agent definition", () => {
    const normalized = normalizeSubagentConfig(
      defineLocalSubagent({
        background: true,
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
      execution: "background",
      kind: "local",
    });
  });

  it("defaults explicit remote subagents to blocking", () => {
    expect(
      normalizeSubagentConfig(
        defineRemoteSubagent({
          description: "Review remotely.",
          url: "https://review.example.com",
        }),
        "Invalid subagent.",
      ),
    ).toMatchObject({ execution: "blocking", kind: "remote" });
  });
});
