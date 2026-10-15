import { z } from "zod";
import { defineTool } from "#public/tools/index.js";

class QuotaError extends Error {
  override name = "QuotaError";
}

// Epoch 90 failed tool results carried only the error message; epoch 91 adds
// an optional `errorName`. Tools that throw their own error classes keep
// compiling and failing the same way.
export default defineTool({
  description: "Look up the remaining quota for a project.",
  inputSchema: z.object({ project: z.string() }),
  execute: ({ project }) => {
    if (project === "") throw new QuotaError("Quota exhausted");
    return { project, remaining: 1 };
  },
});
