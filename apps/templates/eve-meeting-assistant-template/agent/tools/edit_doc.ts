import { defineTool } from "eve/tools";
import { z } from "zod";

import {
  appendBlocks,
  deleteBlock,
  getBlock,
  markdownToBlocks,
  toPageId,
  updateBlock,
} from "../lib/notion.js";
import { followEdit } from "../lib/stage.js";

const blockId = z.string().describe("A block id from `read_doc`.");
const markdown = z
  .string()
  .min(1)
  .max(20_000)
  .describe("Block Markdown, with inline **bold**, *italic*, `code`, and [links](https://...).");

export default defineTool({
  description: [
    "Edit a Notion doc block by block: replace a block, delete one, or insert new blocks after one, or at the end without `after`.",
    "Read it with `read_doc` first, because people may be editing it, and change only the blocks the request is about.",
    "Never rewrite the whole doc.",
  ].join(" "),
  inputSchema: z.object({
    page: z.string().describe("The doc's page id or Notion link."),
    edits: z
      .array(
        z.discriminatedUnion("op", [
          z.object({ op: z.literal("replace"), block: blockId, markdown }),
          z.object({ op: z.literal("delete"), block: blockId }),
          z.object({ op: z.literal("insert"), after: blockId.optional(), markdown }),
        ]),
      )
      .min(1)
      .max(20),
  }),
  async execute({ page, edits }, ctx) {
    const pageId = toPageId(page);
    // Only top-level blocks of this page, so an id can't reach into another doc.
    const onPage = async (id: string) => {
      const found = await getBlock(toPageId(id));
      if (toPageId(found.parent?.page_id ?? "-") !== pageId) {
        throw new Error(
          `Block ${id} isn't a top-level block of this doc. Read it again with read_doc.`,
        );
      }
      return found;
    };
    let firstTouched: string | undefined;
    for (const edit of edits) {
      if (edit.op === "delete") {
        await deleteBlock((await onPage(edit.block)).id);
        continue;
      }
      const blocks = markdownToBlocks(edit.markdown);
      if (edit.op === "insert") {
        const after = edit.after === undefined ? undefined : (await onPage(edit.after)).id;
        const added = await appendBlocks(pageId, blocks, after);
        firstTouched ??= added[0]?.id;
        continue;
      }
      const existing = await onPage(edit.block);
      const [only] = blocks;
      if (blocks.length === 1 && only?.type === existing.type) {
        // Editing in place keeps the block's comments and history.
        await updateBlock(existing.id, { [only.type]: only[only.type] });
        firstTouched ??= existing.id;
      } else {
        // Notion can't change a block's type, so swap in new blocks.
        const added = await appendBlocks(pageId, blocks, existing.id);
        await deleteBlock(existing.id);
        firstTouched ??= added[0]?.id;
      }
    }
    await followEdit(ctx, pageId, firstTouched);
    return { pageId, edits: edits.length };
  },
});
