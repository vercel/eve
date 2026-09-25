import { describe, expect, it } from "vitest";

import { AGENT_TASK_WORKFLOW_ID } from "#tasks/agent-tool.js";
import { SEND_INPUT_SCHEMA_HINT, TASK_ID_INVALID_MESSAGE } from "#tasks/render.js";
import { SUBAGENT_TOOL_INPUT_SCHEMA } from "#tools/framework/agent-contract.js";
import { serializeInputSchema, type ToolSchema } from "#tools/schema.js";
import {
  createPreparedWorkflowToolHarnessDefinition,
  createWorkflowToolHarnessDefinition,
  parseWorkflowToolInput,
} from "./harness-definition.js";

describe("createWorkflowToolHarnessDefinition", () => {
  const research = createWorkflowToolHarnessDefinition({
    definition: {
      description: "Delegate research.",
      execute: () => undefined,
      inputSchema: SUBAGENT_TOOL_INPUT_SCHEMA,
      name: "research",
    },
    nodeId: "subagents/research",
    workflowId: AGENT_TASK_WORKFLOW_ID,
  });
  const validate = async (value: unknown) =>
    await (research.inputSchema as ToolSchema)["~standard"].validate(value);

  it("preserves agent identity on workflow-backed tools", () => {
    expect(research).toMatchObject({ nodeId: "subagents/research" });
  });

  it("gives an agent tool the same bounded taskId as every resumable tool", async () => {
    expect(serializeInputSchema(research.inputSchema as ToolSchema)).toMatchObject({
      properties: { taskId: { maxLength: 128, type: "string" } },
      required: ["message"],
    });
    await expect(validate({ message: "Dig into Alice's report.", taskId: null })).resolves.toEqual({
      value: { message: "Dig into Alice's report." },
    });
    await expect(validate({ message: "More.", taskId: "x".repeat(129) })).resolves.toEqual({
      issues: [{ message: TASK_ID_INVALID_MESSAGE, path: ["taskId"] }],
    });
  });

  it("tells the model a send to an agent uses the agent tool's input schema", async () => {
    const result = await validate({ taskId: "research-7k2m9q", text: "Also check Bob's notes." });
    expect(result.issues?.at(-1)).toEqual({ message: SEND_INPUT_SCHEMA_HINT });
  });
});

describe("createPreparedWorkflowToolHarnessDefinition", () => {
  it("carries a workflow tool's attached option to the harness", () => {
    expect(
      createPreparedWorkflowToolHarnessDefinition({
        description: "Look up an order.",
        inputSchema: { type: "object" },
        kind: "authored-tool",
        logicalPath: "tools/lookup.ts",
        name: "lookup",
        sourceId: "agent",
        task: { attached: true, workflowId: "workflow//./agent/tools/lookup//execute" },
      } as never),
    ).toMatchObject({ attached: true, workflowId: "workflow//./agent/tools/lookup//execute" });
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
