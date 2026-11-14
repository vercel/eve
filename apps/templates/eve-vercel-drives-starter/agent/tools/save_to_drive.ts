import { defineTool } from "eve/tools";
import { z } from "zod";

import {
  DriveBusyError,
  resolveDrivePath,
  withWritableDrive,
} from "../lib/drive";

/**
 * Saves a text file to the Vercel Drive so later sessions can read it.
 *
 * @remarks Busy and invalid-path failures are returned to the model rather than thrown, so it can retry or explain.
 */
export default defineTool({
  description:
    "Save a UTF-8 text file to the shared Vercel Drive, overwriting any file at the same path. " +
    "The /drive folder in this session is a snapshot, so the saved file appears in new sessions and might not appear in this one. " +
    "Returns saved: false with reason drive_busy when another save or upload is using the Drive; retry shortly or tell the user.",
  async execute({ content, path }) {
    let absolute: string;
    try {
      absolute = resolveDrivePath(path);
    } catch (error) {
      return {
        message: error instanceof Error ? error.message : String(error),
        reason: "invalid_path" as const,
        saved: false as const,
      };
    }
    try {
      await withWritableDrive(async (workspace) => {
        await workspace.writeFiles([{ content, path: absolute }]);
      });
    } catch (error) {
      if (error instanceof DriveBusyError) {
        return { reason: "drive_busy" as const, saved: false as const };
      }
      throw error;
    }
    return {
      bytes: Buffer.byteLength(content, "utf-8"),
      path: absolute,
      saved: true as const,
    };
  },
  inputSchema: z.object({
    content: z.string().describe("Full text content of the file."),
    path: z
      .string()
      .min(1)
      .describe(
        'Path relative to the Drive root, such as "notes/standup.md". No leading slash or "..".'
      ),
  }),
});
