const EXPERIMENTAL_WORKFLOW_TOOL_KIND = "eve:enable-workflow-tool";

/** Configuration accepted by {@link experimental_workflow}. */
export interface ExperimentalWorkflowToolInput {
  /**
   * Maximum number of subagent or remote-agent calls one `Workflow` program
   * may dispatch, counted across sequential and parallel calls alike.
   *
   * Calls beyond the limit fail with a `WORKFLOW_SUBAGENT_LIMIT_REACHED`
   * result instead of starting a child session.
   *
   * @default 100
   */
  readonly maxSubagents?: number;
}

/** Framework `Workflow` tool definition returned by {@link experimental_workflow}. */
export interface ExperimentalWorkflowToolDefinition extends ExperimentalWorkflowToolInput {
  readonly kind: typeof EXPERIMENTAL_WORKFLOW_TOOL_KIND;
}

/**
 * Enables and configures the experimental framework `Workflow` tool, an
 * isolated JavaScript sandbox whose only callable operations are this agent's
 * subagents and remote agents. Export the result from
 * `agent/tools/workflow.ts`:
 *
 * ```ts
 * import { experimental_workflow } from "eve/tools";
 *
 * export default experimental_workflow({ maxSubagents: 25 });
 * ```
 *
 * Only the root session sees the tool. The resulting model-facing tool is
 * still called `Workflow`.
 */
export function experimental_workflow(
  input: ExperimentalWorkflowToolInput = {},
): ExperimentalWorkflowToolDefinition {
  const definition: {
    kind: typeof EXPERIMENTAL_WORKFLOW_TOOL_KIND;
    maxSubagents?: number;
  } = {
    kind: EXPERIMENTAL_WORKFLOW_TOOL_KIND,
  };
  if (input.maxSubagents !== undefined) {
    definition.maxSubagents = input.maxSubagents;
  }
  return definition;
}

/** Type guard for a definition returned by {@link experimental_workflow}. */
export function isExperimentalWorkflowToolDefinition(
  value: unknown,
): value is ExperimentalWorkflowToolDefinition {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { kind?: unknown }).kind === EXPERIMENTAL_WORKFLOW_TOOL_KIND
  );
}
