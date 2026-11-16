import type { WorkflowProgramOptions } from "#execution/code-mode/workflow-program.js";
import type { JsonObject } from "#shared/json.js";

export type { WorkflowProgramOptions } from "#execution/code-mode/workflow-program.js";

const WORKFLOW_PROGRAM_OPTIONS = Symbol.for("eve.workflow-program-options");

type WorkflowProgramOptionsCarrier = {
  readonly [WORKFLOW_PROGRAM_OPTIONS]?: WorkflowProgramOptions;
};

export function attachWorkflowProgramOptions<TDefinition extends object>(
  definition: TDefinition,
  options: WorkflowProgramOptions,
): TDefinition {
  Object.defineProperty(definition, WORKFLOW_PROGRAM_OPTIONS, {
    configurable: false,
    enumerable: false,
    value: options,
    writable: false,
  });
  return definition;
}

export function readWorkflowProgramOptions(value: unknown): WorkflowProgramOptions | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  return (value as WorkflowProgramOptionsCarrier)[WORKFLOW_PROGRAM_OPTIONS];
}

/** The input a `workflow()` call's run starts with: the model's code and the author's limit. */
export function createWorkflowProgramExecuteInput(
  options: WorkflowProgramOptions,
  input: unknown,
): JsonObject {
  const code = (input as { readonly code?: unknown } | null)?.code;
  if (typeof code !== "string") throw new TypeError('workflow requires a "code" string.');
  return { code, maxSubagents: options.maxSubagents };
}
