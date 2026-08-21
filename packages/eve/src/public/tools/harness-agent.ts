import type { StandardJSONSchemaV1 } from "#compiled/@standard-schema/spec/index.js";

import {
  createHarnessAgentToolRuntime,
  executeHarnessAgentTool,
  HARNESS_AGENT_TOOL_INPUT_SCHEMA,
} from "#execution/harness-agent/tool.js";
import type {
  CreateHarnessAgentToolSettings,
  FixedHarnessAgentToolInput,
  HarnessAgentToolInput,
} from "#execution/harness-agent/types.js";
import type { ToolDefinition } from "#public/definitions/tool.js";
import { always } from "#public/tools/approval/approval-helpers.js";

/**
 * Defines a flexible HarnessAgent tool. Export it from
 * `agent/tools/harness_agent.ts`; eve derives the runtime name `harness_agent`
 * from that path. Every invocation requires outer tool approval and runs in
 * the current eve sandbox.
 */
export function defineHarnessAgentTool(): ToolDefinition<HarnessAgentToolInput, string> {
  return {
    approval: always(),
    description:
      "Run a coding harness such as Claude Code or Codex in the current eve sandbox to complete a task.",
    async execute(input, ctx) {
      return await executeHarnessAgentTool({
        abortSignal: ctx.abortSignal,
        sandbox: await ctx.getSandbox(),
        toolInput: input,
      });
    },
    inputSchema: HARNESS_AGENT_TOOL_INPUT_SCHEMA,
  };
}

export function createHarnessAgentTool<
  TOutputSchema extends StandardJSONSchemaV1<unknown, unknown>,
>(
  settings: CreateHarnessAgentToolSettings<TOutputSchema> & {
    readonly outputSchema: TOutputSchema;
  },
): ToolDefinition<FixedHarnessAgentToolInput, StandardJSONSchemaV1.InferOutput<TOutputSchema>>;
export function createHarnessAgentTool(
  settings?: CreateHarnessAgentToolSettings,
): ToolDefinition<FixedHarnessAgentToolInput, string>;

/**
 * Creates an approval-gated HarnessAgent tool whose instructions, skills,
 * working directory, enabled harnesses, and per-harness model defaults are
 * fixed in code. The calling model chooses only the task and harness.
 */
export function createHarnessAgentTool(
  settings: CreateHarnessAgentToolSettings<StandardJSONSchemaV1<unknown, unknown> | undefined> = {},
): unknown {
  const runtime = createHarnessAgentToolRuntime(settings);
  const definition: ToolDefinition<FixedHarnessAgentToolInput, unknown> = {
    approval: always(),
    description: "Run a preconfigured coding harness in the current eve sandbox.",
    async execute(input, ctx) {
      return await runtime.execute({
        abortSignal: ctx.abortSignal,
        sandbox: await ctx.getSandbox(),
        toolInput: input,
      });
    },
    inputSchema: runtime.inputSchema,
  };

  return runtime.outputSchema === undefined
    ? definition
    : { ...definition, outputSchema: runtime.outputSchema };
}
