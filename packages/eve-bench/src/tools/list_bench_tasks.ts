import { defineTool } from "eve/tools";
import { never } from "eve/tools/approval";
import { z } from "zod";

import { selectTasks } from "../options.ts";

export const inputSchema = z.object({
  cohort: z.string().min(1).optional(),
  dataset: z.string().min(1).optional(),
});

export default defineTool({
  description: "List task names in an eve benchmark dataset or cohort.",
  inputSchema,
  approval: never(),
  async execute(input) {
    return (await selectTasks(input)).tasks;
  },
});
