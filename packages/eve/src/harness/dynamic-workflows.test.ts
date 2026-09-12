import { jsonSchema } from "ai";
import { describe, expect, it, vi } from "vitest";

vi.mock("#shared/workflow-sandbox.js", () => ({
  createWorkflowSandboxTool: vi.fn(async () => ({ description: "Generated agent API." })),
}));

import { applyDynamicWorkflows } from "#harness/dynamic-workflows.js";
import type { HarnessToolMap } from "#harness/types.js";

function tools(): HarnessToolMap {
  return new Map([
    [
      "workflow",
      {
        description: "Workflow.",
        execution: "background" as const,
        execute: () => undefined,
        inputSchema: jsonSchema({ type: "object" }),
        name: "workflow",
        workflowId: "workflow//eve//dynamicWorkflow",
      },
    ],
    [
      "researcher",
      {
        description: "Research a topic.",
        inputSchema: jsonSchema({ type: "object" }),
        name: "researcher",
        resultKind: "subagent" as const,
        workflowId: "workflow//eve//subagentToolExecuteWorkflow",
      },
    ],
    [
      "bash",
      {
        description: "Run a command.",
        execute: () => "ok",
        inputSchema: jsonSchema({ type: "object" }),
        name: "bash",
      },
    ],
  ]);
}

describe("applyDynamicWorkflows", () => {
  it("pins only subagents and keeps ordinary model tools direct", async () => {
    const harnessTools = tools();
    const modelTools = Object.fromEntries(
      [...harnessTools].map(([name, definition]) => [
        name,
        { description: definition.description, inputSchema: definition.inputSchema },
      ]),
    );
    const applied = await applyDynamicWorkflows({
      continuationSecurity: { signingKey: "test-key" },
      harnessTools,
      maxSubagents: 7,
      tools: modelTools,
    });

    expect(applied.modelTools.workflow?.description).toContain("Use `workflow`");
    expect(applied.modelTools.bash).toBeDefined();
    const executeInput = applied.harnessTools.get("workflow")?.executeInput?.({ js: "return 1" });
    expect(executeInput).toMatchObject({
      agents: [{ name: "researcher" }],
      js: "return 1",
      maxSubagents: 7,
    });
    expect(JSON.stringify(executeInput)).not.toContain("bash");
  });

  it("removes workflow when no subagent is visible", async () => {
    const harnessTools: HarnessToolMap = new Map([
      [
        "workflow",
        {
          description: "Workflow.",
          execution: "background",
          execute: () => undefined,
          inputSchema: jsonSchema({ type: "object" }),
          name: "workflow",
          workflowId: "workflow//eve//dynamicWorkflow",
        },
      ],
    ]);
    const applied = await applyDynamicWorkflows({
      continuationSecurity: { signingKey: "test-key" },
      harnessTools,
      tools: { workflow: { inputSchema: jsonSchema({ type: "object" }) } },
    });
    expect(applied.harnessTools.has("workflow")).toBe(false);
    expect(applied.modelTools.workflow).toBeUndefined();
  });
});
