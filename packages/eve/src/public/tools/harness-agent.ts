import type { StandardJSONSchemaV1 } from "#compiled/@standard-schema/spec/index.js";

import {
  createFixedHarnessAgentToolRuntime,
  DYNAMIC_HARNESS_AGENT_TOOL_INPUT_SCHEMA,
  executeDynamicHarnessAgentTool,
} from "#execution/harness-agent/tool.js";
import type {
  DefineFixedHarnessAgentToolSettings,
  DynamicHarnessAgentToolInput,
  FixedHarnessAgentToolInput,
} from "#execution/harness-agent/types.js";
import type { ToolDefinition } from "#public/definitions/tool.js";
import { always } from "#public/tools/approval/approval-helpers.js";

/** Settings accepted by {@link defineDynamicHarnessAgentTool}. */
export interface DefineDynamicHarnessAgentToolSettings {
  /** Model-facing description for the flexible HarnessAgent tool. */
  readonly description?: string;
}

/**
 * Defines a flexible HarnessAgent tool. Export it from
 * `agent/tools/harness_agent.ts`; eve derives the runtime name `harness_agent`
 * from that path. Every invocation requires outer tool approval and runs in
 * the current eve sandbox.
 */
export function defineDynamicHarnessAgentTool(
  settings: DefineDynamicHarnessAgentToolSettings = {},
): ToolDefinition<DynamicHarnessAgentToolInput, string> {
  return {
    approval: always(),
    description:
      settings.description ??
      "Run a coding harness such as Claude Code or Codex in the current eve sandbox to complete a task.",
    async execute(input, ctx) {
      return await executeDynamicHarnessAgentTool({
        abortSignal: ctx.abortSignal,
        sandbox: await ctx.getSandbox(),
        toolInput: input,
      });
    },
    inputSchema: DYNAMIC_HARNESS_AGENT_TOOL_INPUT_SCHEMA,
  };
}

export function defineFixedHarnessAgentTool<
  TOutputSchema extends StandardJSONSchemaV1<unknown, unknown>,
>(
  settings: DefineFixedHarnessAgentToolSettings<TOutputSchema> & {
    readonly outputSchema: TOutputSchema;
  },
): ToolDefinition<FixedHarnessAgentToolInput, StandardJSONSchemaV1.InferOutput<TOutputSchema>>;
export function defineFixedHarnessAgentTool(
  settings: DefineFixedHarnessAgentToolSettings,
): ToolDefinition<FixedHarnessAgentToolInput, string>;

/**
 * Creates an approval-gated HarnessAgent tool whose instructions, skills,
 * working directory, enabled harnesses, and per-harness model defaults are
 * fixed in code. The calling model chooses only the task and harness.
 */
export function defineFixedHarnessAgentTool(
  settings: DefineFixedHarnessAgentToolSettings<StandardJSONSchemaV1<unknown, unknown> | undefined>,
): unknown {
  const { description, ...runtimeSettings } = settings;
  const runtime = createFixedHarnessAgentToolRuntime(runtimeSettings);
  const definition: ToolDefinition<FixedHarnessAgentToolInput, unknown> = {
    approval: always(),
    description,
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
