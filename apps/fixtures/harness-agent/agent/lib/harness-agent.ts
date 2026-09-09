import type { ToolDefinition } from "eve/tools";
import { always } from "eve/tools/approval";

import { runHarnessAgent } from "./run";
import { HARNESS_AGENT_TOOL_INPUT_SCHEMA } from "./types";
import type {
  CreateHarnessAgentToolSettings,
  HarnessAgentToolInput,
  HarnessAgentToolOutput,
  OptionalOutputSchema,
} from "./types";

/**
 * Creates an approval-gated HarnessAgent tool definition whose instructions,
 * skills, default workDir, and harness are configured in code. The calling
 * model chooses the task and may override workDir for that invocation.
 */
export function createHarnessAgentTool<TOutputSchema extends OptionalOutputSchema = undefined>(
  settings: CreateHarnessAgentToolSettings<TOutputSchema>,
): ToolDefinition<HarnessAgentToolInput, HarnessAgentToolOutput<TOutputSchema>> {
  const { description, workDir: defaultWorkDir, ...runSettings } = settings;
  const definition: ToolDefinition<HarnessAgentToolInput, HarnessAgentToolOutput<TOutputSchema>> = {
    approval: always(),
    description,
    async execute(input, ctx) {
      const workDir = input.workDir ?? defaultWorkDir;
      return await runHarnessAgent({
        abortSignal: ctx.abortSignal,
        ...runSettings,
        sandbox: await ctx.getSandbox(),
        task: input.task,
        ...(workDir === undefined ? {} : { workDir }),
      });
    },
    inputSchema: HARNESS_AGENT_TOOL_INPUT_SCHEMA,
  };

  return (
    settings.outputSchema === undefined
      ? definition
      : { ...definition, outputSchema: settings.outputSchema }
  ) as ToolDefinition<HarnessAgentToolInput, HarnessAgentToolOutput<TOutputSchema>>;
}
