import { defineTool } from "eve/tools";
import { z } from "zod";

import { createPage, markdownToBlocks } from "../lib/notion.js";
import { ensureNotesPage } from "../lib/notes.js";

export default defineTool({
  description:
    "Start a Notion doc, such as a plan or brief someone asks for, as a subpage of this meeting's notes. Everyone on the invite can edit it while the meeting goes on.",
  inputSchema: z.object({
    title: z.string().min(1).max(120),
    markdown: z
      .string()
      .max(20_000)
      .describe(
        "The doc's content: headings, bullets, `- [ ]` tasks, numbered lists, quotes, and code fences.",
      ),
  }),
  async execute({ title, markdown }) {
    const notes = await ensureNotesPage();
    const page = await createPage({
      parentId: notes.pageId,
      title,
      children: markdownToBlocks(markdown),
    });
    return { pageId: page.id, url: page.url };
  },
});
