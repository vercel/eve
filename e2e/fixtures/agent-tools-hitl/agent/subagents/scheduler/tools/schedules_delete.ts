import { defineTool } from "eve/tools";
import { z } from "zod";

/** Stands in for a scheduling service; the tool-stubs evals leave it unstubbed. */
export default defineTool({
  description: "Delete one of Alice's scheduled workflows.",
  inputSchema: z.object({ id: z.string() }),
  async execute() {
    throw new Error("schedules_delete ran its real execute; a stubbed session must not reach it.");
  },
});
