import { describe, expect, it } from "vitest";

import { normalizeToolDefinition } from "#internal/authored-definition/schema-backed.js";
import { dynamicWorkflowReference } from "#execution/dynamic-workflow/workflow-reference.js";
import { attachToolBehavior, readToolBehavior } from "#tools/behavior.js";
import { defineTool } from "#tools/definition.js";
import { workflow } from "#tools/framework/workflow.js";

describe("framework workflow tool", () => {
  it("is a lowercase blocking workflow tool", () => {
    expect(workflow.execution).toBeUndefined();
    expect(Reflect.get(workflow.execute, "workflowId")).toBe(dynamicWorkflowReference.workflowId);
    expect(readToolBehavior(workflow)).toEqual({
      availability: ["root-session"],
      handling: { kind: "workflow-tool", workflowId: dynamicWorkflowReference.workflowId },
    });
    expect(() => normalizeToolDefinition(workflow, "Invalid workflow.")).not.toThrow();
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
