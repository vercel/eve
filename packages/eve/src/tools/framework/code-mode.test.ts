import { describe, expect, it } from "vitest";

import { codeModeWorkflow } from "#execution/code-mode/workflow.js";
import { codeMode } from "#tools/framework/code-mode.js";
import { isBrandedToolEntry } from "#tools/dynamic.js";
import { readToolBehavior } from "#tools/behavior.js";

describe("codeMode", () => {
  it("is a defineTool whose real execute implementation is the workflow body", () => {
    expect(isBrandedToolEntry(codeMode)).toBe(true);
    expect(codeMode.execute).toBe(codeModeWorkflow);
    expect(readToolBehavior(codeMode)).toEqual({
      availability: ["root-session"],
      handling: { kind: "workflow-tool", workflowId: "workflow//eve//codeModeWorkflow" },
    });
  });
});
