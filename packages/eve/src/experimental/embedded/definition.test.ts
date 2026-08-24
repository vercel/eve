import { describe, expect, expectTypeOf, it } from "vitest";

import { defineEmbeddedAgent, type EmbeddedAgentDefinition } from "./definition.js";

describe("defineEmbeddedAgent", () => {
  it("returns a runtime agent definition with non-enumerable embedded metadata", () => {
    const definition = defineEmbeddedAgent({
      instructions: "Classify the ticket.",
      model: "openai/gpt-5.4-mini",
    });

    expect(definition).toEqual({ model: "openai/gpt-5.4-mini" });
    expect(Object.keys(definition)).toEqual(["model"]);
    expect(Object.getOwnPropertySymbols(definition)).toHaveLength(2);
    expectTypeOf(definition).toMatchTypeOf<Omit<EmbeddedAgentDefinition, "instructions">>();
  });

  it("requires string instructions at runtime", () => {
    expect(() =>
      defineEmbeddedAgent({
        instructions: 42 as never,
        model: "openai/gpt-5.4-mini",
      } as EmbeddedAgentDefinition),
    ).toThrow('string "instructions" field');
  });
});
