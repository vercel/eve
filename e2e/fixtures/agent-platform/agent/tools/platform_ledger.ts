import { defineTool } from "eve/tools";
import { never } from "eve/tools/approval";
import { z } from "zod";

import { platformLedger } from "../lib/platform-documents.js";

export default defineTool({
  description: "Report the note and the write count of the platform's document storage.",
  inputSchema: z.object({}),
  approval: never(),
  async execute() {
    const ledger = platformLedger();
    return { note: ledger?.note ?? null, writes: ledger?.writes ?? 0 };
  },
});
