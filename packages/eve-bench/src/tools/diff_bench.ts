import { defineTool } from "eve/tools";
import { never } from "eve/tools/approval";
import { z } from "zod";

import { readJobResult } from "../core/job.ts";
import { diffJobs } from "../core/report.ts";
import { jobDir } from "../options.ts";

export const inputSchema = z.object({
  base: z.string().min(1),
  candidate: z.string().min(1),
});

export default defineTool({
  description: "Compare task rewards between two eve benchmark jobs.",
  inputSchema,
  approval: never(),
  async execute(input) {
    const [base, candidate] = await Promise.all([
      readJobResult(jobDir(input.base)),
      readJobResult(jobDir(input.candidate)),
    ]);
    return diffJobs(base, candidate);
  },
});
