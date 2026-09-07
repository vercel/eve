import { parseJsonObject, type JsonObject, type JsonValue } from "#shared/json.js";

export const DEFAULT_CODE_MODE_MAX_SUBAGENTS = 100;

export type CodeModeMode = "eager" | "lazy";

export type CodeModeCallResolution =
  | { readonly status: "completed"; readonly output: JsonValue }
  | { readonly status: "failed"; readonly error: string };

export interface CodeModeToolCatalogEntry {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: JsonObject;
  readonly outputSchema: JsonObject | null;
  readonly target: "agent" | "tool" | "direct";
}

/**
 * Durable input of one `code_mode` workflow run. The harness resolves the
 * catalog at advertisement time and pins it here so the body replays against
 * the same tool names the model saw, not whatever the deployment has now.
 */
export interface CodeModeWorkflowInput {
  readonly js: string;
  readonly mode: CodeModeMode;
  readonly maxSubagents: number;
  readonly toolCatalog: readonly CodeModeToolCatalogEntry[];
}

export function serializeCodeModeWorkflowInput(input: CodeModeWorkflowInput): JsonObject {
  return {
    js: input.js,
    mode: input.mode,
    maxSubagents: input.maxSubagents,
    toolCatalog: input.toolCatalog.map((entry) => ({ ...entry })),
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
  if (record.mode !== "eager" && record.mode !== "lazy") {
    throw new TypeError('code_mode workflow input requires "mode" of "eager" or "lazy".');
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
      (entry.target !== "agent" && entry.target !== "tool" && entry.target !== "direct")
    ) {
      throw new TypeError("code_mode tool catalog entry is invalid.");
    }
    return {
      name: entry.name,
      description: entry.description,
      inputSchema: parseJsonObject(entry.inputSchema),
      outputSchema: entry.outputSchema === null ? null : parseJsonObject(entry.outputSchema),
      target: entry.target,
    };
  });
  return {
    js: record.js,
    mode: record.mode,
    maxSubagents: record.maxSubagents,
    toolCatalog,
  };
}
