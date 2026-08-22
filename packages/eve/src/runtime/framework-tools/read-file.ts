import { z } from "#compiled/zod/index.js";

/**
 * Shared input schema used by the framework `read_file` tool and any author
 * tool constructed via {@link defineReadFileTool}.
 *
 * Exported so the public `defineReadFileTool` factory and defaults share one
 * model input contract.
 */
export const READ_FILE_INPUT_SCHEMA = z.strictObject({
  filePath: z
    .string()
    .describe("The absolute path to the file to read. A leading $HOME is supported."),
  limit: z
    .number()
    .int()
    .min(1)
    .describe("Maximum number of lines to return. Defaults to 2000.")
    .optional(),
  offset: z
    .number()
    .int()
    .min(1)
    .describe("1-based line number to start from. Defaults to 1.")
    .optional(),
});

/**
 * Shared output schema used by the framework `read_file` tool and any author
 * tool constructed via {@link defineReadFileTool}.
 */
export const READ_FILE_OUTPUT_SCHEMA = z.strictObject({
  content: z.string(),
  nextOffset: z.number().int().min(1).optional(),
  path: z.string(),
  totalLines: z.number().int().min(0),
  truncated: z.boolean(),
});
