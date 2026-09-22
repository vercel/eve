import { z } from "zod";

import { defineTool } from "#public/tools/index.js";

export default defineTool({
  description: "Start a durable report task.",
  execution: "background",
  inputSchema: z.object({ reportId: z.string() }),
  async *execute(input) {
    yield { reportId: input.reportId };
    return { reportId: input.reportId };
  },
});
