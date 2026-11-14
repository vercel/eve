import { defineTool } from "eve/tools";
import { z } from "zod";

import { docLinesToMarkdown, readPage, toPageId } from "../lib/notion.js";

export default defineTool({
  description:
    "Read a Notion page as Markdown, one entry per block with its id for `edit_doc`, including edits people made. Reads the top-level blocks; subpages are listed, not opened.",
  inputSchema: z.object({ page: z.string().describe("The page id or Notion link.") }),
  async execute({ page }) {
    const { title, url, lines } = await readPage(toPageId(page));
    const markdown = docLinesToMarkdown(lines);
    return { title, url, blocks: lines.map((line, i) => ({ id: line.id, markdown: markdown[i] })) };
  },
});
