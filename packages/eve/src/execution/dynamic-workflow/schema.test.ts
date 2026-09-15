import { describe, expect, it } from "vitest";

import {
  parseWorkflowProgramInput,
  readWorkflowProgramAgentCall,
  serializeWorkflowProgramInput,
  type WorkflowProgramInput,
} from "#execution/dynamic-workflow/schema.js";

const input: WorkflowProgramInput = {
  agents: ["researcher", "reviewer"],
  continuationSecurity: { maxAgeMs: 1000, signingKey: "test-key" },
  js: "return null",
  maxSubagents: 7,
};

describe("workflow program schema", () => {
  it("round trips pinned durable input", () => {
    expect(parseWorkflowProgramInput(serializeWorkflowProgramInput(input))).toEqual(input);
  });

  it("rejects invalid helper bounds and allowlists", () => {
    expect(() =>
      parseWorkflowProgramInput({
        ...serializeWorkflowProgramInput(input),
        maxSubagents: 129,
      }),
    ).toThrow("between 1 and 128");
    expect(() =>
      parseWorkflowProgramInput({
        ...serializeWorkflowProgramInput(input),
        agents: ["researcher", "researcher"],
      }),
    ).toThrow("must be unique");
  });

  it("validates bridge payloads before owner dispatch", () => {
    expect(
      readWorkflowProgramAgentCall({
        target: "researcher",
        input: {
          agentId: "agent-1",
          message: "continue",
          outputSchema: { properties: { ok: { type: "boolean" } }, type: "object" },
        },
      }),
    ).toEqual({
      target: "researcher",
      input: {
        agentId: "agent-1",
        message: "continue",
        outputSchema: { properties: { ok: { type: "boolean" } }, type: "object" },
      },
    });
    expect(() => readWorkflowProgramAgentCall({ target: "researcher", input: {} })).toThrow(
      'requires a "message" string',
    );
  });
});
