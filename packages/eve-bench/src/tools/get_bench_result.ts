import { defineTool } from "eve/tools";
import { never } from "eve/tools/approval";
import { z } from "zod";

import { readJobResult } from "../core/job.ts";
import { jobDir } from "../options.ts";

export const inputSchema = z.object({ job: z.string().min(1) });

export default defineTool({
  description: "Read a completed eve benchmark job result.",
  inputSchema,
  approval: never(),
  async execute(input) {
    try {
      return await readJobResult(jobDir(input.job));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new Error(`benchmark result not found for job "${input.job}"`);
      }
      throw error;
    }
  },
});
