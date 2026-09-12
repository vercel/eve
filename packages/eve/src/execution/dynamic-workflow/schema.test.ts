import { describe, expect, it } from "vitest";

import {
  parseDynamicWorkflowInput,
  serializeDynamicWorkflowInput,
  type DynamicWorkflowInput,
} from "#execution/dynamic-workflow/schema.js";

const input: DynamicWorkflowInput = {
  agents: [
    {
      description: "Research a topic.",
      inputSchema: { type: "object" },
      name: "researcher",
      outputSchema: null,
    },
  ],
  continuationSecurity: { maxAgeMs: 1_000, signingKey: "test-key" },
  js: "return await tools.researcher({ message: 'topic' });",
  maxSubagents: 4,
};

describe("dynamic workflow schema", () => {
  it("round trips durable input", () => {
    expect(parseDynamicWorkflowInput(serializeDynamicWorkflowInput(input))).toEqual(input);
  });

  it.each([
    [{ ...serializeDynamicWorkflowInput(input), js: 1 }, 'requires a "js" string'],
    [{ ...serializeDynamicWorkflowInput(input), maxSubagents: 0 }, 'requires "maxSubagents"'],
    [{ ...serializeDynamicWorkflowInput(input), agents: {} }, 'requires an "agents" array'],
  ])("rejects malformed input", (value, message) => {
    expect(() => parseDynamicWorkflowInput(value)).toThrow(message);
  });
});
