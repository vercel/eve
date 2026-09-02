import { describe, expect, it } from "vitest";

import { jsonSchema } from "ai";
import { createWorkflowToolHarnessDefinition, parseWorkflowToolInput } from "./background.js";

describe("createWorkflowToolHarnessDefinition", () => {
  it("marks subagent workflows as callable from Workflow", () => {
    expect(
      createWorkflowToolHarnessDefinition({
        definition: {
          description: "Delegate research.",
          execution: "background",
          execute: () => undefined,
          inputSchema: jsonSchema({ type: "object" }),
          name: "research",
        },
        resultKind: "subagent",
        workflowId: "workflow//eve//subagentToolExecuteWorkflow",
      }),
    ).toMatchObject({ workflowCallable: true });
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
