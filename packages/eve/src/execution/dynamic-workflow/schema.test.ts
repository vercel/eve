import { describe, expect, it } from "vitest";

import {
  parseWorkflowProgramOptions,
  readWorkflowProgramAgentCall,
} from "#execution/dynamic-workflow/schema.js";

const options = {
  agents: ["researcher", "reviewer"],
  maxSubagents: 7,
};

describe("workflow program schema", () => {
  it("rejects invalid helper bounds and allowlists", () => {
    expect(parseWorkflowProgramOptions(options)).toEqual(options);
    expect(() =>
      parseWorkflowProgramOptions({
        ...options,
        maxSubagents: 129,
      }),
    ).toThrow("between 1 and 128");
    expect(() =>
      parseWorkflowProgramOptions({
        ...options,
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
