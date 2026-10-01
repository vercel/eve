import { defineTool } from "eve/tools";
import { z } from "zod";

/** Stands in for a scheduling service; the tool-stubs evals answer it with a stub set. */
export default defineTool({
  description: "List Alice's scheduled workflows.",
  inputSchema: z.object({}),
  async execute() {
    throw new Error(
      "schedules_read ran its real execute; a stubbed session answers it from a stub.",
    );
  },
});
