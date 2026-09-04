import { defineTool } from "eve/tools";
import { z } from "zod";

import { readUpgradeExecution } from "../lib/upgrade-execution.ts";

export default defineTool({
  description: "Read the executable deployment selected for this turn.",
  inputSchema: z.strictObject({ key: z.string() }),
  async execute({ key }) {
    return { key, ...(await readUpgradeExecution()) };
  },
});
