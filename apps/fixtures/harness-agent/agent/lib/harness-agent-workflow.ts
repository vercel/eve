import type { ToolDefinition } from "eve/tools";
import { always } from "eve/tools/approval";

import { HARNESS_AGENT_TOOL_INPUT_SCHEMA } from "./types";
import type {
  CreateHarnessAgentToolSettings,
  HarnessAgentToolInput,
  HarnessAgentToolOutput,
  OptionalOutputSchema,
} from "./types";

export function createHarnessAgentWorkflowTool<
  TOutputSchema extends OptionalOutputSchema = undefined,
>(
  settings: CreateHarnessAgentToolSettings<TOutputSchema>,
): {
  readonly definition: Omit<
    ToolDefinition<HarnessAgentToolInput, HarnessAgentToolOutput<TOutputSchema>>,
    "execute"
  > & { readonly sandbox: true };
  readonly agentSettings: Omit<CreateHarnessAgentToolSettings<TOutputSchema>, "description">;
} {
  const { description, ...agentSettings } = settings;
  const definition = {
    approval: always(),
    description,
    inputSchema: HARNESS_AGENT_TOOL_INPUT_SCHEMA,
    sandbox: true as const,
  };

  return {
    agentSettings,
    definition: (agentSettings.outputSchema === undefined
      ? definition
      : { ...definition, outputSchema: agentSettings.outputSchema }) as Omit<
      ToolDefinition<HarnessAgentToolInput, HarnessAgentToolOutput<TOutputSchema>>,
      "execute"
    > & { readonly sandbox: true },
  };
}
