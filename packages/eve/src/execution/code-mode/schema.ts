import { z } from "#compiled/zod/index.js";

import type { JsonObject, JsonValue } from "#shared/json.js";

export const codeModeInputSchema = z.strictObject({
  js: z.string().describe("Complete JavaScript program to execute over the available tools."),
});

export type CodeModeMode = "eager" | "lazy";

export type CodeModeCallResolution =
  | { readonly status: "completed"; readonly output: JsonValue }
  | { readonly status: "failed"; readonly error: string };

/**
 * Durable input of one `code_mode` workflow run. The harness resolves the
 * catalog at advertisement time and pins it here so the body replays against
 * the same tool names the model saw, not whatever the deployment has now.
 */
export interface CodeModeWorkflowInput {
  readonly js: string;
  readonly mode: CodeModeMode;
  readonly toolNames: readonly string[];
}

export function serializeCodeModeWorkflowInput(input: CodeModeWorkflowInput): JsonObject {
  return { js: input.js, mode: input.mode, toolNames: [...input.toolNames] };
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
    !Array.isArray(record.toolNames) ||
    record.toolNames.some((name) => typeof name !== "string")
  ) {
    throw new TypeError('code_mode workflow input requires "toolNames" as a string array.');
  }
  return { js: record.js, mode: record.mode, toolNames: record.toolNames as string[] };
}
