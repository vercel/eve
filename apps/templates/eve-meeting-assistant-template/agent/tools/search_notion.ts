import { defineTool } from "eve/tools";
import { once } from "eve/tools/approval";
import { z } from "zod";

import { searchPages } from "../lib/notion.js";

export default defineTool({
  description:
    "Search the titles of the Notion pages shared with eve, newest first, such as past meeting notes or last year's plan. Open a result with `read_doc`.",
  inputSchema: z.object({ query: z.string().min(1).max(200) }),
  // Answers land in a chat everyone can read, so someone in the meeting okays
  // the first lookup; the yes holds for the rest of the meeting.
  approval: once(),
  async execute({ query }) {
    return { results: await searchPages(query) };
  },
});
