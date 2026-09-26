import { describe, expect, expectTypeOf, it } from "vitest";
import { z } from "zod";
import * as tools from "#public/tools/index.js";
import { defineTool } from "#tools/definition.js";
import {
  defineWorkflowTool,
  isWorkflowToolDefinition,
  type AgentMessageResult,
  type WorkflowAgentMetadata,
  type WorkflowStepToolContext,
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
        expectTypeOf(ctx.agents.researcher).toEqualTypeOf<WorkflowAgentMetadata | undefined>();
        const review = await ctx.agent("researcher").send("Review the deployment.", {
          outputSchema: z.object({ findings: z.array(z.string()), score: z.number().optional() }),
        });
        expectTypeOf(await review.result()).toEqualTypeOf<
          AgentMessageResult<{ findings: string[]; score?: number | undefined }>
        >();
        // @ts-expect-error The message is sent with send(), not passed to ctx.agent().
        void ctx.agent("researcher", { message: "Review the deployment." });
        // Token capabilities are available when this context is passed into a step.
        void ctx.getToken;
        // @ts-expect-error Workflow bodies do not have a session sandbox.
        void ctx.getSandbox;
        return { deployed: input.service };
      },
      approvalKey(input) {
        expectTypeOf(input).toEqualTypeOf<Readonly<{ service: string }>>();
        return `deploy:${input.service}`;
      },
      toModelOutput(output) {
        expectTypeOf(output).toEqualTypeOf<{ deployed: string }>();
        return { type: "text", value: output.deployed };
      },
    });
    expect(isWorkflowToolDefinition(definition)).toBe(true);
    expectTypeOf(definition.execute).parameter(0).toEqualTypeOf<{ service: string }>();
  });

  it("exposes only step-safe capabilities on WorkflowStepToolContext", () => {
    const useStepContext = (ctx: WorkflowStepToolContext) => {
      void ctx.getToken;
      void ctx.requireAuth;
      void ctx.abortSignal;
      // @ts-expect-error Agent metadata is available only in the workflow body.
      void ctx.agents;
      // @ts-expect-error Agent invocation is available only in the workflow body.
      void ctx.agent;
      // @ts-expect-error Human input is available only in the workflow body.
      void ctx.ask;
    };

    expectTypeOf(useStepContext).parameter(0).toEqualTypeOf<WorkflowStepToolContext>();
  });

  it("rejects the removed execution option", () => {
    const definition = {
      description: "Report a deployment",
      execution: "background",
      inputSchema: z.object({ service: z.string() }),
      async execute() {
        return null;
      },
    };
    expect(() => defineWorkflowTool(definition)).toThrow(
      '"execution" was removed; workflow tool calls now block until they settle.',
    );
  });

  it("keeps workflow capabilities off ordinary tools and top-level exports", () => {
    const definition = defineTool({
      description: "Ordinary",
      inputSchema: z.object({}),
      async execute(_input, ctx) {
        // @ts-expect-error agent is available only on WorkflowToolContext.
        void ctx.agent;
        // @ts-expect-error agents is available only on WorkflowToolContext.
        void ctx.agents;
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
        "use workflow";
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
