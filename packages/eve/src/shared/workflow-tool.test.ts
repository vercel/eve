import { describe, expect, it } from "vitest";

import { readWorkflowToolId } from "#shared/workflow-tool.js";

describe("readWorkflowToolId", () => {
  it("reads the bundler's workflowId stamp from an execute stub", () => {
    const execute = Object.assign(async () => undefined, {
      workflowId: "workflow//./agent/tools/deploy//execute",
    });
    expect(readWorkflowToolId(execute)).toBe("workflow//./agent/tools/deploy//execute");
  });

  it("returns undefined for ordinary functions and non-functions", () => {
    expect(readWorkflowToolId(async () => undefined)).toBeUndefined();
    expect(readWorkflowToolId(Object.assign(() => undefined, { workflowId: "" }))).toBeUndefined();
    expect(readWorkflowToolId({ workflowId: "workflow//x//y" })).toBeUndefined();
    expect(readWorkflowToolId(undefined)).toBeUndefined();
  });
});
