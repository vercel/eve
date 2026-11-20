import { parseJsonObject, type JsonObject, type JsonValue } from "#shared/json.js";

export const DEFAULT_WORKFLOW_PROGRAM_MAX_SUBAGENTS = 100;
export const MAX_WORKFLOW_PROGRAM_MAX_SUBAGENTS = 128;
export const WORKFLOW_PROGRAM_BRIDGE_REQUEST_LIMIT = 256;
export const WORKFLOW_PROGRAM_MAX_AGENT_OUTPUT_BYTES = 4 * 1024 * 1024;

export interface WorkflowProgramContinuationSecurity {
  readonly maxAgeMs?: number;
  readonly signingKey: string;
}

export interface WorkflowProgramInput {
  readonly continuationSecurity: WorkflowProgramContinuationSecurity;
  readonly js: string;
  readonly maxSubagents: number;
}

export type WorkflowProgramOptions = Pick<WorkflowProgramInput, "maxSubagents">;

export interface WorkflowProgramAgentCall {
  readonly input: {
    readonly message: string;
    readonly outputSchema?: JsonObject;
  };
  readonly target: string;
}

export interface WorkflowProgramPendingCall {
  readonly call: WorkflowProgramAgentCall;
  readonly id: string;
}

export type WorkflowProgramCallResult =
  | { readonly output: JsonValue; readonly status: "completed" }
  | { readonly error: string; readonly status: "failed" };

export interface WorkflowProgramResolution {
  readonly interruptionId: string;
  readonly value: WorkflowProgramCallResult;
}

export function parseWorkflowProgramOptions(value: unknown): WorkflowProgramOptions {
  const input = parseJsonObject(value);
  if (
    !isPositiveInteger(input.maxSubagents) ||
    input.maxSubagents > MAX_WORKFLOW_PROGRAM_MAX_SUBAGENTS
  ) {
    throw new TypeError(
      `workflow maxSubagents must be an integer between 1 and ${String(MAX_WORKFLOW_PROGRAM_MAX_SUBAGENTS)}.`,
    );
  }
  return { maxSubagents: input.maxSubagents };
}

export function readWorkflowProgramAgentCall(value: unknown): WorkflowProgramAgentCall {
  const call = parseJsonObject(value);
  if (typeof call.target !== "string" || call.target.trim() === "") {
    throw new TypeError("Workflow program ctx.agent() requires a non-empty agent name.");
  }
  const rawInput = parseJsonObject(call.input);
  if (typeof rawInput.message !== "string") {
    throw new TypeError('Workflow program ctx.agent() requires a "message" string.');
  }
  const input: {
    message: string;
    outputSchema?: JsonObject;
  } = { message: rawInput.message };
  if (rawInput.outputSchema !== undefined) {
    input.outputSchema = parseJsonObject(rawInput.outputSchema);
  }
  return { input, target: call.target };
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}
