import { describe, expect, it } from "vitest";

import { defineAgent, isDefinedAgent } from "#public/definitions/agent.js";

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
});
