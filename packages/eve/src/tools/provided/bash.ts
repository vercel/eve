import { z } from "#compiled/zod/index.js";

import {
  DEFAULT_BASH_TIMEOUT_SECONDS,
  executeBashOnSandbox,
  MAX_BASH_TIMEOUT_SECONDS,
  type BashInput,
} from "#execution/sandbox/bash.js";
import { defineTool, type ToolDefinition } from "#tools/definition.js";

/**
 * Input schema for the provided `bash` tool.
 */
export const BASH_INPUT_SCHEMA = z.strictObject({
  command: z.string().describe("The shell command to execute."),
  timeout: z
    .number()
    .positive()
    .describe(
      `Optional timeout in seconds. Defaults to ${DEFAULT_BASH_TIMEOUT_SECONDS}, max ${MAX_BASH_TIMEOUT_SECONDS}.`,
    )
    .optional(),
});

/**
 * Output schema for the provided `bash` tool.
 */
export const BASH_OUTPUT_SCHEMA = z.strictObject({
  exitCode: z.number(),
  stderr: z.string(),
  stdout: z.string(),
  truncated: z.boolean(),
});

export type BashToolInput = z.infer<typeof BASH_INPUT_SCHEMA>;
export type BashToolOutput = z.infer<typeof BASH_OUTPUT_SCHEMA>;

/**
 * Framework-owned executors stay statically imported so hosted server bundles
 * can trace and rewrite them into deployable output chunks.
 *
 * These modules are only used by the Nitro-hosted runtime path. Their deeper
 * sandbox dependencies remain lazily loaded inside the execution layer, so the
 * top-level import here does not force those backends to initialize eagerly.
 */
export const bash: ToolDefinition<BashToolInput, BashToolOutput> = defineTool({
  description: [
    "Execute a shell command in the shared workspace environment.",
    `Commands time out after ${DEFAULT_BASH_TIMEOUT_SECONDS} seconds by default and may request up to ${MAX_BASH_TIMEOUT_SECONDS} seconds.`,
  ].join(" "),
  async execute(input, ctx) {
    return await executeBashOnSandbox(await ctx.getSandbox(), input as BashInput, {
      abortSignal: ctx.abortSignal,
    });
  },
  inputSchema: BASH_INPUT_SCHEMA,
  outputSchema: BASH_OUTPUT_SCHEMA,
});

export default bash;
