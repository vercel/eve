import { describe, expect, expectTypeOf, it } from "vitest";
import { z } from "zod";
import * as tools from "#public/tools/index.js";
import { defineTool } from "#tools/definition.js";
import {
  defineWorkflowTool,
  isWorkflowToolDefinition,
  type WorkflowToolContext,
} from "#tools/workflow-definition.js";
import { normalizeToolDefinition } from "#internal/authored-definition/schema-backed.js";

describe("defineWorkflowTool", () => {
  it("infers input, output, and the workflow context", () => {
    const definition = defineWorkflowTool({
      description: "Deploy",
      inputSchema: z.object({ service: z.string() }),
      async execute(input, ctx) {
        expectTypeOf(input).toEqualTypeOf<{ service: string }>();
        expectTypeOf(ctx).toEqualTypeOf<WorkflowToolContext>();
        // @ts-expect-error Workflow bodies do not have turn-owned token access.
        void ctx.getToken;
        // @ts-expect-error Workflow bodies do not have a session sandbox.
        void ctx.getSandbox;
        return { deployed: input.service };
      },
      toModelOutput(output) {
        expectTypeOf(output).toEqualTypeOf<{ deployed: string }>();
        return { type: "text", value: output.deployed };
      },
    });
    expect(isWorkflowToolDefinition(definition)).toBe(true);
    expectTypeOf(definition.execute).parameter(0).toEqualTypeOf<{ service: string }>();
  });

  it("provides task messages and receipt projections for background workflows", () => {
    const definition = defineWorkflowTool({
      description: "Report a deployment",
      execution: "background",
      inputSchema: z.object({ service: z.string() }),
      async *execute(input, ctx, task) {
        expectTypeOf(input).toEqualTypeOf<{ service: string }>();
        expectTypeOf(ctx).toEqualTypeOf<WorkflowToolContext>();
        expectTypeOf(task.taskId).toEqualTypeOf<string>();
        yield { status: "planning" };
        yield task.postMessage(input.service);
        return { deployed: input.service };
      },
      toModelOutput(receipt) {
        expectTypeOf(receipt).toEqualTypeOf<import("#tools/task.js").TaskReceipt>();
        return { type: "text", value: receipt.taskId };
      },
    });
    expect(isWorkflowToolDefinition(definition)).toBe(true);
  });

  it("keeps workflow capabilities off ordinary tools and top-level exports", () => {
    const definition = defineTool({
      description: "Ordinary",
      inputSchema: z.object({}),
      async execute(_input, ctx) {
        // @ts-expect-error agent is available only on WorkflowToolContext.
        void ctx.agent;
        // @ts-expect-error ask is available only on WorkflowToolContext.
        void ctx.ask;
        return 1;
      },
    });
    expect(isWorkflowToolDefinition(definition)).toBe(false);
    expect(tools).not.toHaveProperty("agent");
    expect(tools).not.toHaveProperty("ask");
  });

  it("rejects an uncompiled workflow tool rather than running it inline", () => {
    const definition = defineWorkflowTool({
      description: "Workflow",
      inputSchema: {},
      async execute() {
        return 1;
      },
    });
    expect(() => normalizeToolDefinition(definition, "Invalid tool.")).toThrow(
      "requires a compiled workflow executor",
    );
  });

  it.each(["defineTool", "bare object"])("rejects a workflow executor in %s", (kind) => {
    const execute = Object.assign(async () => 1, { workflowId: "workflow//test//execute" });
    const definition = { description: "Ordinary", inputSchema: {}, execute };
    expect(() =>
      normalizeToolDefinition(
        kind === "defineTool" ? defineTool(definition) : definition,
        "Invalid tool.",
      ),
    ).toThrow("Workflow executors require defineWorkflowTool()");
  });
});
