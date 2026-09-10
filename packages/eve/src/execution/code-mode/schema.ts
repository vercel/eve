import type { AgentCodeModeDefinition } from "#shared/agent-definition.js";
import { parseJsonObject, type JsonObject, type JsonValue } from "#shared/json.js";

export const DEFAULT_CODE_MODE_MAX_SUBAGENTS = 100;

export interface CodeModeOptions {
  readonly maxSubagents: number;
}

/** The effective `code_mode` options for an agent, or `undefined` when the tool is off. */
export function resolveCodeModeOptions(
  codeMode: boolean | AgentCodeModeDefinition | undefined,
): CodeModeOptions | undefined {
  if (codeMode === undefined || codeMode === false) return undefined;
  const options = codeMode === true ? {} : codeMode;
  return { maxSubagents: options.maxSubagents ?? DEFAULT_CODE_MODE_MAX_SUBAGENTS };
}

/** The resolution a nested call gets when its approval is refused, by the policy or by the person. */
export function approvalDenied(
  by: string,
  toolName: string,
  reason?: string,
): { readonly status: "failed"; readonly error: string } {
  const detail = reason === undefined ? "" : ` ${reason}`;
  return {
    status: "failed",
    error: `CODE_MODE_APPROVAL_DENIED: ${by} declined to run "${toolName}".${detail}`,
  };
}

export type CodeModeCallTarget = "agent" | "tool" | "workflow" | "direct";

export interface CodeModeToolCatalogEntry {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: JsonObject;
  readonly outputSchema: JsonObject | null;
  readonly target: CodeModeCallTarget;
  /** Registered workflow body of an authored workflow tool; present exactly when `target` is `"workflow"`. */
  readonly workflowId?: string;
}

/**
 * Durable input of one `code_mode` workflow run. The harness resolves the
 * catalog at advertisement time and pins it here so the body replays against
 * the same tool names the model saw, not whatever the deployment has now.
 */
export interface CodeModeWorkflowInput {
  readonly js: string;
  readonly maxSubagents: number;
  readonly toolCatalog: readonly CodeModeToolCatalogEntry[];
}

export function serializeCodeModeWorkflowInput(input: CodeModeWorkflowInput): JsonObject {
  return {
    js: input.js,
    maxSubagents: input.maxSubagents,
    toolCatalog: input.toolCatalog.map(({ workflowId, ...entry }) => {
      const serialized: Record<string, JsonValue> = { ...entry };
      if (workflowId !== undefined) serialized.workflowId = workflowId;
      return serialized;
    }),
  };
}

export function parseCodeModeWorkflowInput(value: unknown): CodeModeWorkflowInput {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("code_mode workflow input must be an object.");
  }
  const record = value as Record<string, unknown>;
  if (typeof record.js !== "string") {
    throw new TypeError('code_mode workflow input requires a "js" string.');
  }
  if (
    typeof record.maxSubagents !== "number" ||
    !Number.isSafeInteger(record.maxSubagents) ||
    record.maxSubagents <= 0
  ) {
    throw new TypeError('code_mode workflow input requires "maxSubagents" as a positive integer.');
  }
  if (!Array.isArray(record.toolCatalog)) {
    throw new TypeError('code_mode workflow input requires a "toolCatalog" array.');
  }
  const toolCatalog = record.toolCatalog.map((value): CodeModeToolCatalogEntry => {
    const entry = parseJsonObject(value);
    if (
      typeof entry.name !== "string" ||
      typeof entry.description !== "string" ||
      !isCodeModeCallTarget(entry.target)
    ) {
      throw new TypeError("code_mode tool catalog entry is invalid.");
    }
    const parsed: CodeModeToolCatalogEntry = {
      name: entry.name,
      description: entry.description,
      inputSchema: parseJsonObject(entry.inputSchema),
      outputSchema: entry.outputSchema === null ? null : parseJsonObject(entry.outputSchema),
      target: entry.target,
    };
    if (entry.target === "workflow") {
      if (typeof entry.workflowId !== "string" || entry.workflowId.length === 0) {
        throw new TypeError(
          `code_mode tool catalog entry "${entry.name}" targets a workflow without a workflowId.`,
        );
      }
      return { ...parsed, workflowId: entry.workflowId };
    }
    if (entry.workflowId !== undefined) {
      throw new TypeError(
        `code_mode tool catalog entry "${entry.name}" carries a workflowId for a non-workflow target.`,
      );
    }
    return parsed;
  });
  return {
    js: record.js,
    maxSubagents: record.maxSubagents,
    toolCatalog,
  };
}

function isCodeModeCallTarget(value: unknown): value is CodeModeCallTarget {
  return value === "agent" || value === "tool" || value === "workflow" || value === "direct";
}
