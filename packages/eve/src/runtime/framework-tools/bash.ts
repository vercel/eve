import { type BashInput, executeBashOnSandbox } from "#execution/sandbox/bash-tool.js";
import { requireSandboxSession } from "#execution/sandbox/require-sandbox.js";
import type { JsonObject } from "#shared/json.js";
import type { ResolvedToolDefinition } from "#runtime/types.js";

/**
 * Shared input schema used by the framework `bash` tool and any author tool
 * constructed via {@link defineBashTool}.
 *
 * Exported so the public `defineBashTool` factory and the framework
 * `BASH_TOOL_DEFINITION` use the exact same schema object — keeping model
 * input contracts in sync without duplication.
 */
export const BASH_INPUT_SCHEMA: JsonObject = {
  additionalProperties: false,
  properties: {
    command: {
      description: "The shell command to execute.",
      type: "string",
    },
  },
  required: ["command"],
  type: "object",
};

/**
 * Shared output schema used by the framework `bash` tool and any author tool
 * constructed via {@link defineBashTool}.
 */
export const BASH_OUTPUT_SCHEMA: JsonObject = {
  additionalProperties: false,
  properties: {
    exitCode: { type: "number" },
    stderr: { type: "string" },
    stdout: { type: "string" },
    truncated: { type: "boolean" },
  },
  required: ["exitCode", "stderr", "stdout", "truncated"],
  type: "object",
};

/**
 * Framework-owned executors stay statically imported so hosted server bundles
 * can trace and rewrite them into deployable output chunks.
 *
 * These modules are only used by the Nitro-hosted runtime path. Their deeper
 * sandbox dependencies remain lazily loaded inside the execution layer, so the
 * top-level import here does not force those backends to initialize eagerly.
 */
async function executeBash(input: unknown): Promise<unknown> {
  return executeBashOnSandbox(await requireSandboxSession(), input as BashInput);
}

export const BASH_TOOL_DEFINITION: ResolvedToolDefinition = {
  description: "Execute a shell command in the shared workspace environment.",
  execute: executeBash,
  inputSchema: BASH_INPUT_SCHEMA,
  logicalPath: "eve:framework/bash",
  name: "bash",
  outputSchema: BASH_OUTPUT_SCHEMA,
  sourceId: "eve:bash-tool",
  sourceKind: "module",
};
