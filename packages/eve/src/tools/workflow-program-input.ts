import type { WorkflowProgramOptions } from "#execution/dynamic-workflow/schema.js";
import type { JsonObject } from "#shared/json.js";

export type { WorkflowProgramOptions } from "#execution/dynamic-workflow/schema.js";

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

export function createWorkflowProgramExecuteInput(
  options: WorkflowProgramOptions,
  input: unknown,
): JsonObject {
  const js = (input as { readonly js?: unknown } | null)?.js;
  if (typeof js !== "string") throw new TypeError('workflow requires a "js" string.');
  return {
    js,
    maxSubagents: options.maxSubagents,
  };
}
