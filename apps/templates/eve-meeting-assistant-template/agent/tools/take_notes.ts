import { defineTool } from "eve/tools";
import { z } from "zod";

import { block } from "../lib/notion.js";
import { addToSection, ensureNotesPage, setSummary } from "../lib/notes.js";
import { followEdit } from "../lib/stage.js";

const item = z
  .string()
  .min(1)
  .max(1_000)
  .describe("One line. Inline Markdown such as **bold** works.");

export default defineTool({
  description:
    "Add to this meeting's notes page in Notion. The first call creates the page and returns its link. Only adds what's new; never repeat earlier notes.",
  inputSchema: z.object({
    title: z
      .string()
      .max(120)
      .optional()
      .describe(
        "The meeting's topic, used only when the page is created, such as `Q3 customer event planning`.",
      ),
    summary: z
      .string()
      .max(2_000)
      .optional()
      .describe("Replaces the summary at the top: two to four sentences on the meeting so far."),
    notes: z.array(item).max(30).optional().describe("New discussion points, one short line each."),
    decisions: z.array(item).max(20).optional(),
    actionItems: z
      .array(z.object({ task: item, owner: z.string().max(100).optional() }))
      .max(20)
      .optional(),
  }),
  async execute({ title, summary, notes = [], decisions = [], actionItems = [] }, ctx) {
    const page = await ensureNotesPage(title);
    if (summary) await setSummary(page, summary);
    const added = [
      await addToSection(
        page,
        "actions",
        actionItems.map(({ task, owner }) =>
          block("to_do", owner ? `**${owner}**: ${task}` : task, { checked: false }),
        ),
      ),
      await addToSection(
        page,
        "decisions",
        decisions.map((text) => block("bulleted_list_item", text)),
      ),
      await addToSection(
        page,
        "notes",
        notes.map((text) => block("bulleted_list_item", text)),
      ),
    ];
    // On screen, follow the first thing added, or the summary when that's all that changed.
    await followEdit(
      ctx,
      page.pageId,
      added.find(Boolean) ?? (summary ? page.summaryId : undefined),
    );
    return { url: page.url, pageId: page.pageId, created: page.created };
  },
});
