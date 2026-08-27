import { describe, expect, it } from "vitest";

import { normalizeMemoryDefinition } from "#internal/authored-definition/memory.js";
import { defineMemory } from "#public/memory/index.js";

const message = "Invalid memory definition.";

function validDefinition() {
  return defineMemory({
    provider: {
      capture: {
        "compaction.requested": async () => {},
        "turn.completed": async () => {},
      },
      recall: {
        "compaction.completed": async () => null,
        "turn.started": async () => null,
      },
      tools: async () => null,
    },
    scope: "user_1",
  });
}

describe("normalizeMemoryDefinition", () => {
  it("accepts lifecycle-keyed recall and capture handlers", () => {
    const definition = validDefinition();

    expect(normalizeMemoryDefinition(definition, message)).toBe(definition);
  });

  it("rejects the former function-shaped recall contract", () => {
    const definition = {
      ...validDefinition(),
      provider: { recall: async () => null },
    };

    expect(() => normalizeMemoryDefinition(definition, message)).toThrow(
      '"provider.recall" must be an object',
    );
  });

  it("rejects unknown lifecycle keys", () => {
    const definition = validDefinition();
    const invalid = {
      ...definition,
      provider: {
        ...definition.provider,
        recall: { ...definition.provider.recall, "turn.completed": async () => null },
      },
    };

    expect(() => normalizeMemoryDefinition(invalid, message)).toThrow("Unknown key");
  });

  it("rejects non-function capture handlers", () => {
    const definition = validDefinition();
    const invalid = {
      ...definition,
      provider: {
        ...definition.provider,
        capture: { "turn.completed": true },
      },
    };

    expect(() => normalizeMemoryDefinition(invalid, message)).toThrow(
      /provider\.capture\["turn\.completed"\].*must be a function/,
    );
  });
});
