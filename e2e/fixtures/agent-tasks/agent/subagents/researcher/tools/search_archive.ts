import { setTimeout } from "node:timers/promises";

import { defineTool } from "eve/tools";
import { never } from "eve/tools/approval";
import { z } from "zod";

import { findChurnNote } from "../../../../findings.ts";

const SEARCH_MS = 15_000;

/** A slow search, so a researcher task is still working when a new message arrives. */
export default defineTool({
  description: "Search the team's research archive for notes that answer a metrics question.",
  inputSchema: z.object({
    question: z.string().describe("The question, with region and quarter."),
  }),
  approval: never(),
  async execute({ question }, ctx) {
    await setTimeout(SEARCH_MS, undefined, { signal: ctx.abortSignal });
    return findChurnNote(question);
  },
});
