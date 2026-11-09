import { describe, expect, it } from "vitest";

import { defineAgent, isDefinedAgent } from "#public/definitions/agent.js";
import { defineTool } from "#tools/definition.js";

describe("defineAgent", () => {
  it("brands the definition it returns without adding a visible key", () => {
    const input = { model: "openai/gpt-5.4" };
    const agent = defineAgent(input);

    expect(agent).toBe(input);
    expect(isDefinedAgent(agent)).toBe(true);
    expect(Object.keys(agent)).toEqual(["model"]);
  });

  it("does not accept a plain object or a spread copy", () => {
    expect(isDefinedAgent({ model: "openai/gpt-5.4" })).toBe(false);
    expect(isDefinedAgent({ ...defineAgent({ model: "openai/gpt-5.4" }) })).toBe(false);
    expect(isDefinedAgent(null)).toBe(false);
  });

  it("takes an agent/ directory's contents as fields, with code subagents as defineAgent values", () => {
    const agent = defineAgent({
      instructions: () => "Ship carefully.",
      model: "openai/gpt-5.4",
      name: "release",
      subagents: {
        reviewer: defineAgent({ description: "Reviews.", model: "openai/gpt-5.4" }),
      },
      tools: {
        deploy: defineTool({
          description: "Deploy.",
          execute: async () => ({}),
          inputSchema: { type: "object" },
        }),
      },
      version: "2",
    });
    expect(Object.keys(agent).sort()).toEqual([
      "instructions",
      "model",
      "name",
      "subagents",
      "tools",
      "version",
    ]);
    // @ts-expect-error schedules aren't a field of an agent defined in code
    defineAgent({ model: "openai/gpt-5.4", schedules: {} });
    // @ts-expect-error a subagent is what defineAgent returns, not a plain object
    defineAgent({ model: "openai/gpt-5.4", subagents: { reviewer: { model: "openai/gpt-5.4" } } });
  });
});
