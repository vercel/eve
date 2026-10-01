import { defineTool } from "eve/tools";
import { always } from "eve/tools/approval";
import { z } from "zod";

/** Stands in for a scheduling service; the tool-stubs evals answer it with a stub set. */
export default defineTool({
  description: "Schedule a new workflow for Alice. Requires approval.",
  inputSchema: z.object({ name: z.string() }),
  approval: always(),
  async execute() {
    throw new Error(
      "schedules_create ran its real execute; a stubbed session answers it from a stub.",
    );
  },
});
