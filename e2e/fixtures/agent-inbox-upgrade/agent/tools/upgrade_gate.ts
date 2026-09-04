import { defineTool } from "eve/tools";
import { ask } from "eve/workflow";
import { z } from "zod";

import { readUpgradeExecution } from "../lib/upgrade-execution.ts";

export default defineTool({
  description: "Hold a blocking workflow across an eve deployment upgrade.",
  inputSchema: z.strictObject({ key: z.string() }),
  async execute({ key }, ctx) {
    "use workflow";

    const before = await readUpgradeExecution();
    const answer = await ask(ctx, {
      prompt: `UPGRADE-GATE ${key} ${JSON.stringify(before)}`,
      options: [{ id: "continue", label: "Continue" }],
    });
    return { key, before, after: await readUpgradeExecution(), answer: answer.optionId };
  },
});
