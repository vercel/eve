import { z } from "#compiled/zod/index.js";

import {
  executeWriteFileOnSandbox,
  type WriteFileInput,
} from "#execution/sandbox/write-file-tool.js";
import { defineTool } from "#public/definitions/tool.js";

/**
 * Input schema for the framework `write_file` tool and any author tool
 * constructed via {@link defineWriteFileTool}. Single source of truth so
 * model input contracts stay in sync without duplication.
 */
export const WRITE_FILE_INPUT_SCHEMA = z.strictObject({
  content: z.string().describe("Complete replacement file contents."),
  filePath: z
    .string()
    .describe("The absolute path to the file to write. A leading $HOME is supported."),
});

/**
 * Output schema for the framework `write_file` tool and any author tool
 * constructed via {@link defineWriteFileTool}.
 */
export const WRITE_FILE_OUTPUT_SCHEMA = z.strictObject({
  existed: z.boolean(),
  path: z.string(),
});

/**
 * Framework `write_file` tool: writes a file in the agent's sandbox with
 * read-before-write enforcement and stale-read detection. Import from
 * `eve/tools/write_file` to spread, wrap, or re-export it from
 * `agent/tools/write_file.ts`.
 */
export default defineTool({
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
  inputSchema: WRITE_FILE_INPUT_SCHEMA,
  outputSchema: WRITE_FILE_OUTPUT_SCHEMA,
  execute: async (input, ctx) =>
    executeWriteFileOnSandbox(await ctx.getSandbox(), input as WriteFileInput),
});
