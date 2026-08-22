import { z } from "#compiled/zod/index.js";

/**
 * Shared input schema used by the framework `write_file` tool and any author
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
 * Shared output schema used by the framework `write_file` tool and any author
 * tool constructed via {@link defineWriteFileTool}.
 */
export const WRITE_FILE_OUTPUT_SCHEMA = z.strictObject({
  existed: z.boolean(),
  path: z.string(),
});
