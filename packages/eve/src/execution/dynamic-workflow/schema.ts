import { parseJsonObject, parseJsonValue, type JsonObject, type JsonValue } from "#shared/json.js";

export const DEFAULT_WORKFLOW_PROGRAM_MAX_SUBAGENTS = 100;
export const MAX_WORKFLOW_PROGRAM_MAX_SUBAGENTS = 128;
export const WORKFLOW_PROGRAM_BRIDGE_REQUEST_LIMIT = 256;
export const WORKFLOW_PROGRAM_CALL_INTERRUPT_KIND = "eve.workflow-program-agent-call";

export interface WorkflowProgramCallInterrupt {
  readonly kind: typeof WORKFLOW_PROGRAM_CALL_INTERRUPT_KIND;
  readonly task: undefined;
  readonly toolInput: unknown;
  readonly toolName: "agent";
}

export interface WorkflowProgramContinuationSecurity {
  readonly maxAgeMs?: number;
  readonly signingKey: string;
}

/** Internal durable input pinned for one generated program run. */
export interface WorkflowProgramInput {
  readonly continuationSecurity: WorkflowProgramContinuationSecurity;
  readonly js: string;
  readonly maxSubagents: number;
}

export interface WorkflowProgramAgentCall {
  readonly input: {
    readonly agentId?: string;
    readonly message: string;
    readonly outputSchema?: JsonObject;
  };
  readonly target: string;
}

export function parseWorkflowProgramInput(value: unknown): WorkflowProgramInput {
  const input = parseJsonObject(value);
  if (typeof input.js !== "string") {
    throw new TypeError('workflow requires a "js" string.');
  }
  if (
    !isPositiveInteger(input.maxSubagents) ||
    input.maxSubagents > MAX_WORKFLOW_PROGRAM_MAX_SUBAGENTS
  ) {
    throw new TypeError(
      `workflow maxSubagents must be an integer between 1 and ${String(MAX_WORKFLOW_PROGRAM_MAX_SUBAGENTS)}.`,
    );
  }
  const continuationSecurity = parseJsonObject(input.continuationSecurity);
  if (typeof continuationSecurity.signingKey !== "string") {
    throw new TypeError("Workflow program continuation security is missing a signing key.");
  }
  if (
    continuationSecurity.maxAgeMs !== undefined &&
    !isPositiveInteger(continuationSecurity.maxAgeMs)
  ) {
    throw new TypeError("Workflow program continuation maxAgeMs must be a positive integer.");
  }
  return {
    continuationSecurity: {
      maxAgeMs: continuationSecurity.maxAgeMs as number | undefined,
      signingKey: continuationSecurity.signingKey,
    },
    js: input.js,
    maxSubagents: input.maxSubagents,
  };
}

export function readWorkflowProgramCallInterrupt(input: {
  readonly payload: unknown;
}): WorkflowProgramCallInterrupt {
  const payload = input.payload as Partial<WorkflowProgramCallInterrupt>;
  if (payload.kind !== WORKFLOW_PROGRAM_CALL_INTERRUPT_KIND || payload.toolName !== "agent") {
    throw new Error(`Unsupported workflow program interrupt kind "${String(payload.kind)}".`);
  }
  return {
    kind: WORKFLOW_PROGRAM_CALL_INTERRUPT_KIND,
    task: undefined,
    toolInput: payload.toolInput,
    toolName: "agent",
  };
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
  if (rawInput.agentId !== undefined && typeof rawInput.agentId !== "string") {
    throw new TypeError('Workflow program ctx.agent() "agentId" must be a string.');
  }
  const input: {
    agentId?: string;
    message: string;
    outputSchema?: JsonObject;
  } = { message: rawInput.message };
  if (rawInput.agentId !== undefined) input.agentId = rawInput.agentId;
  if (rawInput.outputSchema !== undefined) {
    input.outputSchema = parseJsonObject(rawInput.outputSchema);
  }
  return { input, target: call.target };
}

export function serializeWorkflowProgramInput(input: WorkflowProgramInput): JsonObject {
  const continuationSecurity: Record<string, JsonValue> = {
    signingKey: input.continuationSecurity.signingKey,
  };
  if (input.continuationSecurity.maxAgeMs !== undefined) {
    continuationSecurity.maxAgeMs = input.continuationSecurity.maxAgeMs;
  }
  return {
    continuationSecurity,
    js: input.js,
    maxSubagents: input.maxSubagents,
  };
}

export function parseWorkflowProgramOutput(value: unknown): JsonValue {
  return parseJsonValue(value ?? null);
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}
