import { describe, expect, it } from "vitest";

import { jsonSchema } from "ai";
import { createWorkflowToolHarnessDefinition } from "./harness-definition.js";

describe("createWorkflowToolHarnessDefinition", () => {
  it("preserves agent identity on workflow-backed tools", () => {
    expect(
      createWorkflowToolHarnessDefinition({
        definition: {
          description: "Delegate research.",
          execute: () => undefined,
          inputSchema: jsonSchema({ type: "object" }),
          name: "research",
        },
        nodeId: "subagents/research",
        workflowId: "workflow//eve//subagentToolExecuteWorkflow",
      }),
    ).toMatchObject({ execute: undefined, nodeId: "subagents/research" });
  });
});
