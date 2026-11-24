import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import { defineTool } from "eve/tools";
import { z } from "zod";

export default defineTool({
  description: "Saves one thank-you email draft for a customer.",
  inputSchema: z.object({ customerId: z.string(), subject: z.string(), body: z.string() }),
  async execute(draft) {
    const dir = process.env.REPRO_OUT;
    if (dir !== undefined) {
      mkdirSync(dir, { recursive: true });
      appendFileSync(join(dir, "drafts.jsonl"), `${JSON.stringify(draft)}\n`);
    }
    return { saved: true };
  },
});
