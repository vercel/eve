import type { HarnessAgentAdapter } from "@ai-sdk/harness/agent";
import type { ToolSet } from "ai";
import type { ToolDefinition } from "eve/tools";
import { always } from "eve/tools/approval";

import { HARNESS_AGENT_TOOL_INPUT_SCHEMA } from "./types";
import type {
  CreateHarnessAgentToolDefinitionArgs,
  HarnessAgentToolInput,
  HarnessAgentToolOutput,
  OptionalOutputSchema,
} from "./types";

/**
 * Creates an approval-gated HarnessAgent tool definition whose instructions,
 * skills, and default workDir are configured in code. The calling model
 * chooses the task and may override workDir for that invocation.
 */
export function createHarnessAgentToolDefinition<
  THarness extends HarnessAgentAdapter<any> = HarnessAgentAdapter,
  TUserTools extends ToolSet = {},
  RuntimeContext extends Record<string, unknown> = Record<string, unknown>,
  TOutputSchema extends OptionalOutputSchema = undefined,
  CallOptions = never,
>(
  args: CreateHarnessAgentToolDefinitionArgs<
    THarness,
    TUserTools,
    RuntimeContext,
    TOutputSchema,
    CallOptions
  >,
): Omit<ToolDefinition<HarnessAgentToolInput, HarnessAgentToolOutput<TOutputSchema>>, "execute"> {
  const definition: Omit<
    ToolDefinition<HarnessAgentToolInput, HarnessAgentToolOutput<TOutputSchema>>,
    "execute"
  > = {
    approval: always(),
    description: args.description,
    inputSchema: HARNESS_AGENT_TOOL_INPUT_SCHEMA,
  };

  return (
    args.settings.outputSchema === undefined
      ? definition
      : { ...definition, outputSchema: args.settings.outputSchema }
  ) as Omit<
    ToolDefinition<HarnessAgentToolInput, HarnessAgentToolOutput<TOutputSchema>>,
    "execute"
  >;
}
