import { z } from "#compiled/zod/index.js";

import { type BashInput, executeBashOnSandbox } from "#execution/sandbox/bash-tool.js";
import { requireSandboxSession } from "#execution/sandbox/require-sandbox.js";
import type { ResolvedToolDefinition } from "#runtime/types.js";
import type { ToolExecuteOptions } from "#shared/tool-definition.js";

/**
 * Shared input schema used by the framework `bash` tool and any author tool
 * constructed via {@link defineBashTool}.
 *
 * Exported so the public `defineBashTool` factory and the framework
 * `BASH_TOOL_DEFINITION` use the exact same schema object — keeping model
 * input contracts in sync without duplication.
 */
export const BASH_INPUT_SCHEMA = z.strictObject({
  command: z.string().describe("The shell command to execute."),
});

/**
 * Shared output schema used by the framework `bash` tool and any author tool
 * constructed via {@link defineBashTool}.
 */
export const BASH_OUTPUT_SCHEMA = z.strictObject({
  exitCode: z.number(),
  stderr: z.string(),
  stdout: z.string(),
  truncated: z.boolean(),
});

/**
 * Framework-owned executors stay statically imported so hosted server bundles
 * can trace and rewrite them into deployable output chunks.
 *
 * These modules are only used by the Nitro-hosted runtime path. Their deeper
 * sandbox dependencies remain lazily loaded inside the execution layer, so the
 * top-level import here does not force those backends to initialize eagerly.
 */
async function executeBash(input: unknown, options?: ToolExecuteOptions): Promise<unknown> {
  return executeBashOnSandbox(
    await requireSandboxSession(options?.abortSignal),
    input as BashInput,
  );
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
