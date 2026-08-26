import { defineTool } from "eve/tools";
import { z } from "zod";

/**
 * Fetches the diff for the pull request under review. A real factory
 * would call the forge's API; the example returns a canned diff so the
 * layout stays self-contained.
 */
export default defineTool({
  description: "Fetches the unified diff for a pull request by number.",
  inputSchema: z.object({
    pullRequest: z.number().int().positive(),
  }),
  async execute(input) {
    return {
      pullRequest: input.pullRequest,
      diff: "--- a/src/index.ts\n+++ b/src/index.ts\n@@ -1 +1 @@\n-export const answer = 41;\n+export const answer = 42;\n",
    };
  },
});
