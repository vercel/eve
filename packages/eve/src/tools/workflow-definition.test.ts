import { describe, expect, expectTypeOf, it } from "vitest";
import { z } from "zod";
import * as tools from "#public/tools/index.js";
import { defineTool } from "#tools/definition.js";
import {
  defineWorkflowTool,
  isWorkflowToolDefinition,
  MAX_DETACH_TIMEOUT_MS,
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
        const review = ctx.agent("researcher", {
          message: "Review the deployment.",
          outputSchema: {
            properties: {
              findings: { items: { type: "string" }, type: "array" },
              score: { type: "number" },
            },
            required: ["findings"],
            type: "object",
          },
        });
        expectTypeOf(review).toEqualTypeOf<Promise<{ findings: string[]; score?: number }>>();
        // @ts-expect-error The subagent name is the first argument, not part of the input.
        void ctx.agent({ message: "Review the deployment.", target: "researcher" });
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

  it("provides progress yields and projects the returned output", () => {
    const definition = defineWorkflowTool({
      description: "Report a deployment",
      inputSchema: z.object({ service: z.string() }),
      async *execute(input, ctx) {
        expectTypeOf(input).toEqualTypeOf<{ service: string }>();
        expectTypeOf(ctx).toEqualTypeOf<WorkflowToolContext>();
        yield { status: "planning" };
        return { status: `deployed ${input.service}` };
      },
      toModelOutput(output) {
        expectTypeOf(output).toEqualTypeOf<{ status: string }>();
        return { type: "text", value: output.status };
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

  it.each([true, false, { timeout: 120_000 }])("accepts detach: %j and compiles it", (detach) => {
    const execute = Object.assign(async () => 1, { workflowId: "workflow//remind//execute" });
    const definition = defineWorkflowTool({
      description: "Remind Alice later.",
      detach,
      execute,
      inputSchema: {},
    });

    const entry = normalizeToolDefinition(definition, "Invalid tool.");

    expect(entry).toMatchObject({ definition: { detach }, kind: "tool" });
  });

  it.each([
    ["a string", "always"],
    ["a zero timeout", { timeout: 0 }],
    ["a negative timeout", { timeout: -5 }],
    ["an infinite timeout", { timeout: Number.POSITIVE_INFINITY }],
    ["a timeout in seconds as a string", { timeout: "30s" }],
    ["an unknown key", { timeout: 1_000, after: 5 }],
  ])("rejects detach given %s", (_label, detach) => {
    expect(() =>
      defineWorkflowTool({
        description: "Remind Alice later.",
        detach: detach as never,
        async execute() {
          "use workflow";
          return 1;
        },
        inputSchema: {},
      }),
    ).toThrow(
      'defineWorkflowTool: "detach" must be true, false, or { timeout } with a positive number of milliseconds',
    );
  });

  it("rejects a detach timeout no timer can schedule", () => {
    const define = (timeout: number) =>
      defineWorkflowTool({
        description: "Remind Alice later.",
        detach: { timeout },
        async execute() {
          "use workflow";
          return 1;
        },
        inputSchema: {},
      });

    expect(() => define(MAX_DETACH_TIMEOUT_MS)).not.toThrow();
    expect(() => define(Number.MAX_SAFE_INTEGER)).toThrow(
      `defineWorkflowTool: "detach.timeout" must be at most ${MAX_DETACH_TIMEOUT_MS} milliseconds (about 24.8 days), received ${Number.MAX_SAFE_INTEGER}.`,
    );
  });

  it("rejects detach on a tool that is not a workflow tool", () => {
    const definition = { description: "Ordinary", detach: true, execute: async () => 1 };

    expect(() => normalizeToolDefinition(definition, "Invalid tool.")).toThrow(
      '"detach" is only supported on defineWorkflowTool()',
    );
  });

  it.each<number | false>([30 * 60_000, false])(
    "accepts timeout: %j and compiles it",
    (timeout) => {
      const execute = Object.assign(async () => 1, { workflowId: "workflow//run_tests//execute" });
      const definition = defineWorkflowTool({
        description: "Run Bob's test suite.",
        execute,
        inputSchema: {},
        timeout,
      });

      const entry = normalizeToolDefinition(definition, "Invalid tool.");

      expect(entry).toMatchObject({ definition: { timeout }, kind: "tool" });
    },
  );

  it.each([
    ["zero", 0],
    ["a negative number", -1_000],
    ["infinity", Number.POSITIVE_INFINITY],
    ["a duration string", "30m"],
    ["true", true],
  ])("rejects timeout given %s", (_label, timeout) => {
    expect(() =>
      defineWorkflowTool({
        description: "Run Bob's test suite.",
        async execute() {
          "use workflow";
          return 1;
        },
        inputSchema: {},
        timeout: timeout as never,
      }),
    ).toThrow(
      'defineWorkflowTool: "timeout" must be a positive number of milliseconds or false, received',
    );
  });

  it("rejects timeout on a tool that is not a workflow tool", () => {
    const definition = { description: "Ordinary", execute: async () => 1, timeout: 1_000 };

    expect(() => normalizeToolDefinition(definition, "Invalid tool.")).toThrow(
      '"timeout" is only supported on defineWorkflowTool()',
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
