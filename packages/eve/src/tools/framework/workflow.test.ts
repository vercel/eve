import { describe, expect, it } from "vitest";

import { normalizeToolDefinition } from "#internal/authored-definition/schema-backed.js";
import { dynamicWorkflowReference } from "#execution/dynamic-workflow/workflow-reference.js";
import { attachToolBehavior, readToolBehavior } from "#tools/behavior.js";
import { defineTool } from "#tools/definition.js";
import { defaultWorkflow, workflow } from "#tools/framework/workflow.js";
import { isWorkflowToolDefinition } from "#tools/workflow-definition.js";

describe("framework workflow tool", () => {
  it("provides a lowercase blocking workflow tool", () => {
    expect(isWorkflowToolDefinition(defaultWorkflow)).toBe(true);
    expect(defaultWorkflow.execution).toBeUndefined();
    expect(Reflect.get(defaultWorkflow.execute, "workflowId")).toBe(
      dynamicWorkflowReference.workflowId,
    );
    expect(readToolBehavior(defaultWorkflow)).toEqual({
      availability: ["root-session"],
      handling: {
        kind: "workflow-tool",
        maxSubagents: undefined,
        workflowId: dynamicWorkflowReference.workflowId,
      },
    });
    expect(() => normalizeToolDefinition(defaultWorkflow, "Invalid workflow.")).not.toThrow();
  });

  it("configures and bounds the child-call budget", () => {
    expect(readToolBehavior(workflow({ maxSubagents: 7 }))?.handling).toMatchObject({
      kind: "workflow-tool",
      maxSubagents: 7,
    });
    expect(() => workflow({ maxSubagents: 0 })).toThrow("between 1 and 128");
    expect(() => workflow({ maxSubagents: 129 })).toThrow("between 1 and 128");
    expect(() => workflow({ maxSubagents: Number.MAX_SAFE_INTEGER })).toThrow("between 1 and 128");
  });

  it("rejects an attached workflow id that differs from the executor", () => {
    const execute = Object.assign(async () => null, { workflowId: "workflow//eve//actual" });
    const definition = attachToolBehavior(
      defineTool({ description: "Mismatch.", execute, inputSchema: { type: "object" } }),
      {
        availability: [],
        handling: { kind: "workflow-tool", workflowId: "workflow//eve//other" },
      },
    );
    expect(() => normalizeToolDefinition(definition, "Invalid workflow.")).toThrow(
      "Workflow executors require defineWorkflowTool()",
    );
  });
});
