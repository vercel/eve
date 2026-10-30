import { describe, expect, it } from "vitest";

import {
  parseWorkflowProgramOptions,
  readWorkflowProgramAgentCall,
} from "#execution/dynamic-workflow/schema.js";

const options = { maxSubagents: 7 };

describe("workflow program schema", () => {
  it("validates the trusted call budget", () => {
    expect(parseWorkflowProgramOptions(options)).toEqual(options);
    expect(() =>
      parseWorkflowProgramOptions({
        ...options,
        maxSubagents: 129,
      }),
    ).toThrow("between 1 and 128");
  });

  it("validates bridge payloads before owner dispatch", () => {
    expect(
      readWorkflowProgramAgentCall({
        target: "researcher",
        input: {
          message: "continue",
          outputSchema: { properties: { ok: { type: "boolean" } }, type: "object" },
        },
      }),
    ).toEqual({
      target: "researcher",
      input: {
        message: "continue",
        outputSchema: { properties: { ok: { type: "boolean" } }, type: "object" },
      },
    });
    expect(() => readWorkflowProgramAgentCall({ target: "researcher", input: {} })).toThrow(
      'requires a "message" string',
    );
  });
});
