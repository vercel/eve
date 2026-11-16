import { describe, expect, it } from "vitest";

import { runWorkflowProgramTask } from "#execution/code-mode/workflow-program.js";
import { normalizeToolDefinition } from "#internal/authored-definition/schema-backed.js";
import { workflow } from "#tools/provided/workflow.js";
import {
  createWorkflowProgramExecuteInput,
  readWorkflowProgramOptions,
} from "#tools/workflow-program-input.js";
import { isWorkflowToolDefinition } from "#tools/workflow-definition.js";
import { serializeInputSchema } from "#tools/schema.js";

describe("workflow", () => {
  it("defines a task tool that takes a program in the language eve__execute runs", () => {
    const definition = workflow({ maxSubagents: 7 });

    expect(isWorkflowToolDefinition(definition)).toBe(true);
    expect(definition.task).toBe(runWorkflowProgramTask);
    expect(serializeInputSchema(definition.inputSchema)).toEqual({
      additionalProperties: false,
      properties: {
        code: {
          description: "The body of an async function: use `await` and `return` at the top level.",
          type: "string",
        },
      },
      required: ["code"],
      type: "object",
    });
    // What sets it apart from a program in the turn: it is a task, and it reaches agents only.
    expect(definition.description).toContain("in the background");
    expect(definition.description).toContain("await tools.<name>({ message, outputSchema? })");
    expect(definition.description).toContain("`tools` holds agents only");
    expect(definition.description).toContain("A program may call agents at most 7 times.");
  });

  it("carries the author's agent limit through the compiled definition into each run's input", () => {
    const previousWorkflowId = Reflect.get(runWorkflowProgramTask, "workflowId");
    Reflect.set(runWorkflowProgramTask, "workflowId", "workflow//test//runWorkflowProgramTask");
    try {
      const normalized = normalizeToolDefinition(
        workflow({ maxSubagents: 4 }),
        "Invalid workflow.",
      );
      expect(normalized).toMatchObject({
        definition: { workflowProgram: { maxSubagents: 4 } },
        kind: "tool",
      });
    } finally {
      if (previousWorkflowId === undefined) {
        Reflect.deleteProperty(runWorkflowProgramTask, "workflowId");
      } else {
        Reflect.set(runWorkflowProgramTask, "workflowId", previousWorkflowId);
      }
    }

    expect(createWorkflowProgramExecuteInput({ maxSubagents: 4 }, { code: "return 1" })).toEqual({
      code: "return 1",
      maxSubagents: 4,
    });
    expect(() =>
      createWorkflowProgramExecuteInput({ maxSubagents: 4 }, { js: "return 1" }),
    ).toThrow('workflow requires a "code" string.');
  });

  it("allows as many agent calls as any program unless the author lowers the limit", () => {
    expect(readWorkflowProgramOptions(workflow())).toEqual({ maxSubagents: 128 });
    expect(() => workflow({ maxSubagents: 0 })).toThrow("between 1 and 128");
    expect(() => workflow({ maxSubagents: 129 })).toThrow("between 1 and 128");
  });
});
