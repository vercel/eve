import { z } from "#compiled/zod/index.js";

import {
  executeWriteFileOnSandbox,
  type WriteFileInput,
} from "#execution/sandbox/write-file-tool.js";
import type { ToolDefinition } from "#public/definitions/tool.js";

/**
 * Shared input schema used by eve's default `write_file` tool and any author
 * tool constructed via {@link defineWriteFileTool}.
 *
 * Exported so the public `defineWriteFileTool` factory and defaults share one
 * model input contract.
 */
export const WRITE_FILE_INPUT_SCHEMA = z.strictObject({
  content: z.string().describe("Complete replacement file contents."),
  filePath: z
    .string()
    .describe("The absolute path to the file to write. A leading $HOME is supported."),
});

/**
 * Shared output schema used by eve's default `write_file` tool and any author
 * tool constructed via {@link defineWriteFileTool}.
 */
export const WRITE_FILE_OUTPUT_SCHEMA = z.strictObject({
  existed: z.boolean(),
  path: z.string(),
});

/** Input accepted by {@link defineWriteFileTool}. */
export interface DefineWriteFileToolInput {
  /** Optional model-facing description. */
  readonly description?: string;
}

/** Defines a file-writer tool that executes in the agent sandbox. */
export function defineWriteFileTool(input: DefineWriteFileToolInput = {}): ToolDefinition {
  return {
    description: input.description ?? "Write a file to the workspace sandbox.",
    async execute(args, ctx) {
      return executeWriteFileOnSandbox(await ctx.getSandbox(), args as WriteFileInput);
    },
    inputSchema: WRITE_FILE_INPUT_SCHEMA,
    outputSchema: WRITE_FILE_OUTPUT_SCHEMA,
  };
}

/** eve's canonical default file-writer definition. */
export const writeFile: ToolDefinition = defineWriteFileTool({
  description: [
    "Writes a file to the local filesystem.",
    "",
    "Usage:",
    "- This tool will overwrite the existing file if there is one at the provided path.",
    "- If this is an existing file, you MUST use the read_file tool first to read the file's contents. This tool will fail if you did not read the file first.",
    "- ALWAYS prefer editing existing files in the codebase. NEVER write new files unless explicitly required.",
    "- NEVER proactively create documentation files (*.md) or README files. Only create documentation files if explicitly requested by the User.",
    "- Only use emojis if the user explicitly requests it. Avoid writing emojis to files unless asked.",
  ].join("\n"),
});
