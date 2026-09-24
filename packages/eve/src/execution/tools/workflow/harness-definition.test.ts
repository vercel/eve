import { describe, expect, it } from "vitest";

import { jsonSchema } from "ai";
import { AGENT_TASK_WORKFLOW_ID } from "#tasks/agent-tool.js";
import {
  createPreparedWorkflowToolHarnessDefinition,
  createWorkflowToolHarnessDefinition,
  parseWorkflowToolInput,
} from "./harness-definition.js";

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
        workflowId: AGENT_TASK_WORKFLOW_ID,
      }),
    ).toMatchObject({ nodeId: "subagents/research" });
  });
});

describe("createPreparedWorkflowToolHarnessDefinition", () => {
  it("carries a workflow tool's detach option to the harness", () => {
    expect(
      createPreparedWorkflowToolHarnessDefinition({
        description: "Remind Alice later.",
        inputSchema: { type: "object" },
        kind: "authored-tool",
        logicalPath: "tools/remind.ts",
        name: "remind",
        sourceId: "agent",
        task: { detach: true, workflowId: "workflow//./agent/tools/remind//execute" },
      } as never),
    ).toMatchObject({ detach: true, workflowId: "workflow//./agent/tools/remind//execute" });
  });

  it("carries a workflow tool's timeout to the harness", () => {
    expect(
      createPreparedWorkflowToolHarnessDefinition({
        description: "Run Bob's test suite.",
        inputSchema: { type: "object" },
        kind: "authored-tool",
        logicalPath: "tools/run_tests.ts",
        name: "run_tests",
        sourceId: "agent",
        task: { timeout: 60_000, workflowId: "workflow//./agent/tools/run_tests//execute" },
      } as never),
    ).toMatchObject({ timeout: 60_000 });
  });
});

describe("parseWorkflowToolInput", () => {
  it("passes a JSON object through", () => {
    expect(parseWorkflowToolInput({ service: "api" }, "deploy")).toEqual({ service: "api" });
  });

  it("rejects an input that cannot cross the run boundary, naming the tool", () => {
    for (const input of [new Date(0), "api", 42, null, undefined, ["api"]]) {
      expect(() => parseWorkflowToolInput(input, "deploy")).toThrow(
        /Tool "deploy" is a workflow, so its parsed input must be a JSON object/u,
      );
    }
  });
});
