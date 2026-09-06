import { describe, expect, it } from "vitest";

import { readWorkflowSandboxProgramFailure } from "#shared/workflow-sandbox.js";

describe("readWorkflowSandboxProgramFailure", () => {
  it.each([
    "RUN_USER_SOURCE_ERROR",
    "CODE_MODE_TOOL_ERROR",
    "CODE_MODE_SOURCE_TOO_LARGE",
    "CODE_MODE_BRIDGE_LIMIT",
    "CODE_MODE_DETACHED_BRIDGE_REQUEST",
    "CODE_MODE_SERIALIZATION_ERROR",
  ])("returns %s to the model", (code) => {
    expect(readWorkflowSandboxProgramFailure({ code, message: "Fix the program" })).toBe(
      "Fix the program",
    );
  });

  it.each([
    "RUN_ERROR",
    "RUN_PROTOCOL_ERROR",
    "RUN_SERIALIZATION_ERROR",
    "CODE_MODE_PROTOCOL_ERROR",
    "CODE_MODE_HOST_TOOL_ERROR",
    "CODE_MODE_TIMEOUT",
    "CODE_MODE_ABORTED",
    "CODE_MODE_CONCURRENCY_LIMIT",
    "UNKNOWN",
  ])("preserves %s for infrastructure handling", (code) => {
    expect(readWorkflowSandboxProgramFailure({ code, message: "failure" })).toBeUndefined();
  });

  it.each([
    null,
    undefined,
    "failure",
    new Error("worker failed"),
    { code: "RUN_USER_SOURCE_ERROR" },
  ])("preserves uncategorized errors", (error) => {
    expect(readWorkflowSandboxProgramFailure(error)).toBeUndefined();
  });
});
