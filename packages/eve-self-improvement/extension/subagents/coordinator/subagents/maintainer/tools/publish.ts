import { defineTool } from "eve/tools";
import { z } from "zod";
import extension from "../../../../../extension.js";
import { publishCandidate } from "../../../../../lib/publish.js";

export default defineTool({
  description:
    "Publish the complete bounded change to the active experiment's deterministic branch as a signed draft PR. The controller independently reruns tests, review and release gates. Does not merge or deploy.",
  inputSchema: z.object({
    paths: z.array(z.string()).min(1).max(100),
    summary: z.string().min(1).max(8000),
    addressedThreads: z.array(z.string()).max(100).default([]),
  }),
  execute: (input, ctx) => publishCandidate(extension.config, ctx, input),
});
