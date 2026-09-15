import { parseJsonObject, parseJsonValue, type JsonObject, type JsonValue } from "#shared/json.js";

export const DEFAULT_WORKFLOW_PROGRAM_MAX_SUBAGENTS = 100;
export const MAX_WORKFLOW_PROGRAM_MAX_SUBAGENTS = 128;
export const MAX_WORKFLOW_PROGRAM_AGENTS = 128;
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
  readonly agents: readonly string[];
  readonly continuationSecurity: WorkflowProgramContinuationSecurity;
  readonly js: string;
  readonly maxSubagents: number;
}

export type WorkflowProgramOptions = Pick<WorkflowProgramInput, "agents" | "maxSubagents">;

export interface WorkflowProgramAgentCall {
  readonly input: {
    readonly agentId?: string;
    readonly message: string;
    readonly outputSchema?: JsonObject;
  };
  readonly target: string;
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
  if (!Array.isArray(input.agents)) {
    throw new TypeError('workflow requires an "agents" allowlist.');
  }
  if (input.agents.length === 0 || input.agents.length > MAX_WORKFLOW_PROGRAM_AGENTS) {
    throw new TypeError(
      `workflow requires between 1 and ${String(MAX_WORKFLOW_PROGRAM_AGENTS)} allowed agents.`,
    );
  }
  const agents = input.agents.map((agent) => {
    if (typeof agent !== "string" || agent.trim() === "") {
      throw new TypeError("workflow agent names must be non-empty strings.");
    }
    return agent;
  });
  if (new Set(agents).size !== agents.length) {
    throw new TypeError("workflow agent names must be unique.");
  }
  return { agents, maxSubagents: input.maxSubagents };
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

export function parseWorkflowProgramOutput(value: unknown): JsonValue {
  return parseJsonValue(value ?? null);
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}
