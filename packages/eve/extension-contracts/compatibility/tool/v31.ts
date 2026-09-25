import { z } from "zod";
import { defineTool, defineWorkflowTool } from "#public/tools/index.js";

export const write = defineTool({
  description: "Write an approved message.",
  inputSchema: z.object({ message: z.string() }),
  outputSchema: z.object({ written: z.string() }),
  approval: ({ toolInput }) => (toolInput?.message ? "user-approval" : "not-applicable"),
  execute: (input) => ({ written: input.message }),
  toModelOutput: (output) => ({ type: "text", value: output.written }),
});

export const workflow = defineWorkflowTool({
  description: "Run a report workflow.",
  inputSchema: z.object({ report: z.string() }),
  async execute(input) {
    "use workflow";
    return { report: input.report };
  },
});
