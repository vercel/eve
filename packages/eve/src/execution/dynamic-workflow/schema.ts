import { z } from "#compiled/zod/index.js";

import { parseJsonObject, type JsonObject, type JsonValue } from "#shared/json.js";

export const DEFAULT_DYNAMIC_WORKFLOW_MAX_SUBAGENTS = 100;
export const DYNAMIC_WORKFLOW_CALL_INTERRUPT_KIND = "eve.dynamic-workflow-call";

export interface DynamicWorkflowCallInterrupt {
  readonly kind: typeof DYNAMIC_WORKFLOW_CALL_INTERRUPT_KIND;
  readonly task: undefined;
  readonly toolInput: unknown;
  readonly toolName: string;
}

export const dynamicWorkflowInputSchema = z.strictObject({
  js: z
    .string()
    .describe(
      "Complete JavaScript orchestration program. Call only the agents listed in the workflow description and return one JSON-serializable result.",
    ),
});

export interface DynamicWorkflowAgent {
  readonly description: string;
  readonly inputSchema: JsonObject;
  readonly name: string;
  readonly outputSchema: JsonObject | null;
}

export interface DynamicWorkflowContinuationSecurity {
  readonly maxAgeMs?: number;
  readonly signingKey: string;
}

/** Internal durable input pinned after the model-visible tool input is validated. */
export interface DynamicWorkflowInput {
  readonly agents: readonly DynamicWorkflowAgent[];
  readonly continuationSecurity: DynamicWorkflowContinuationSecurity;
  readonly js: string;
  readonly maxSubagents: number;
}

export function serializeDynamicWorkflowInput(input: DynamicWorkflowInput): JsonObject {
  const continuationSecurity: Record<string, JsonValue> = {
    signingKey: input.continuationSecurity.signingKey,
  };
  if (input.continuationSecurity.maxAgeMs !== undefined) {
    continuationSecurity.maxAgeMs = input.continuationSecurity.maxAgeMs;
  }
  return {
    agents: input.agents.map((agent) => ({ ...agent })),
    continuationSecurity,
    js: input.js,
    maxSubagents: input.maxSubagents,
  };
}

export function parseDynamicWorkflowInput(value: unknown): DynamicWorkflowInput {
  const input = parseJsonObject(value);
  if (typeof input.js !== "string") {
    throw new TypeError('workflow input requires a "js" string.');
  }
  if (!isPositiveInteger(input.maxSubagents)) {
    throw new TypeError('workflow input requires "maxSubagents" as a positive integer.');
  }
  if (!Array.isArray(input.agents)) {
    throw new TypeError('workflow input requires an "agents" array.');
  }
  const agents = input.agents.map((value): DynamicWorkflowAgent => {
    const agent = parseJsonObject(value);
    if (typeof agent.name !== "string" || typeof agent.description !== "string") {
      throw new TypeError("workflow agent catalog entry is invalid.");
    }
    return {
      description: agent.description,
      inputSchema: parseJsonObject(agent.inputSchema),
      name: agent.name,
      outputSchema: agent.outputSchema === null ? null : parseJsonObject(agent.outputSchema),
    };
  });
  const continuationSecurity = parseJsonObject(input.continuationSecurity);
  if (typeof continuationSecurity.signingKey !== "string") {
    throw new TypeError('workflow input requires a continuation security "signingKey".');
  }
  if (
    continuationSecurity.maxAgeMs !== undefined &&
    !isPositiveInteger(continuationSecurity.maxAgeMs)
  ) {
    throw new TypeError('workflow continuation security "maxAgeMs" must be a positive integer.');
  }
  return {
    agents,
    continuationSecurity: {
      maxAgeMs: continuationSecurity.maxAgeMs as number | undefined,
      signingKey: continuationSecurity.signingKey,
    },
    js: input.js,
    maxSubagents: input.maxSubagents,
  };
}

export function readDynamicWorkflowCallInterrupt(input: {
  readonly payload: unknown;
}): DynamicWorkflowCallInterrupt {
  const payload = input.payload as Partial<DynamicWorkflowCallInterrupt>;
  if (
    payload.kind !== DYNAMIC_WORKFLOW_CALL_INTERRUPT_KIND ||
    typeof payload.toolName !== "string"
  ) {
    throw new Error(`Unsupported workflow interrupt kind "${String(payload.kind)}".`);
  }
  return {
    kind: DYNAMIC_WORKFLOW_CALL_INTERRUPT_KIND,
    task: undefined,
    toolInput: payload.toolInput,
    toolName: payload.toolName,
  };
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}
