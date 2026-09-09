import type { HarnessAgentAdapter } from "@ai-sdk/harness/agent";
import type { ToolSet } from "ai";
import type { ToolDefinition } from "eve/tools";
import { always } from "eve/tools/approval";

import { HARNESS_AGENT_TOOL_INPUT_SCHEMA } from "./types";
import type {
  CreateHarnessAgentWorkflowToolDefinitionArgs,
  HarnessAgentToolInput,
  HarnessAgentToolOutput,
  OptionalOutputSchema,
} from "./types";

export function createHarnessAgentWorkflowToolDefinition<
  THarness extends HarnessAgentAdapter<any> = HarnessAgentAdapter,
  TUserTools extends ToolSet = {},
  RuntimeContext extends Record<string, unknown> = Record<string, unknown>,
  TOutputSchema extends OptionalOutputSchema = undefined,
  CallOptions = never,
>(
  args: CreateHarnessAgentWorkflowToolDefinitionArgs<
    THarness,
    TUserTools,
    RuntimeContext,
    TOutputSchema,
    CallOptions
  >,
): Omit<ToolDefinition<HarnessAgentToolInput, HarnessAgentToolOutput<TOutputSchema>>, "execute"> & {
  readonly sandbox: true;
} {
  const definition = {
    approval: always(),
    description: args.description,
    inputSchema: HARNESS_AGENT_TOOL_INPUT_SCHEMA,
    sandbox: true as const,
  };

  return (
    args.settings.outputSchema === undefined
      ? definition
      : { ...definition, outputSchema: args.settings.outputSchema }
  ) as Omit<
    ToolDefinition<HarnessAgentToolInput, HarnessAgentToolOutput<TOutputSchema>>,
    "execute"
  > & { readonly sandbox: true };
}
