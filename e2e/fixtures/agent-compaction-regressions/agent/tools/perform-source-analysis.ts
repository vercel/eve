import { defineState } from "eve/context";
import { defineTool } from "eve/tools";
import { todo } from "eve/tools/todo";
import { z } from "zod";

const completionMarker = "SOURCE_ANALYSIS_COMPLETE";
const invocationCount = defineState("compaction-regression.perform-source-analysis", () => 0);

export default defineTool({
  description:
    "Review the reading-list application's modules and return Alice's completed findings for Bob's handoff.",
  inputSchema: z.object({
    approach: z.string().min(1),
  }),
  async execute(input, ctx) {
    const attempt = invocationCount.get() + 1;
    invocationCount.update(() => attempt);
    await todo.execute(
      {
        todos: [{ content: "Complete source analysis", priority: "high", status: "pending" }],
      },
      ctx,
    );

    return {
      completed: true,
      completionMarker,
      workUnit: "source-analysis",
      hardStop: attempt >= 10,
      attempt,
      approach: input.approach,
      findings: [
        "The application entry point loads the display settings and connects the book catalog, reading lists, and preview pages. The catalog is ready before the first page is shown.",
        "Catalog records contain a book identifier, title, author, and shelf label. A search with no matching books returns an empty list and a friendly note beside the search box.",
        "Reading lists store book identifiers in the order chosen by the reader. Adding a book already on the list keeps its existing position, while an empty list remains a normal starting point.",
        "The list preview combines the saved book identifiers with titles from the catalog. It shows the title and author together, followed by the shelf label on the next line.",
        "The list repository saves the list title and its selected books together. It returns a list reference after saving, allowing the preview page to show the recorded selection.",
        "Preview templates use the saved list data. Book titles appear as plain text, and the template includes a short count of the books followed by their ordered entries.",
        "The catalog helper checks whether a selected book is still listed before preparing a preview. If a title has moved, the page keeps the reading list available for a later update.",
        "Display preferences include the page size and the choice of a compact or spacious layout. Optional descriptions can remain blank when the reader prefers a simple list of titles.",
        "The print-view helper receives the saved list reference. Opening the print view leaves the list unchanged, so the reader can return to the same selection afterward.",
        "The saved-lists page shows recently prepared lists first. It uses a bounded page size and provides a next-page link when there are more lists to display.",
        "The archive action reads the saved list state before updating it. A list already in the archive remains there when the same action is selected again.",
        "Alice's source review is complete and these findings are ready for Bob. The shared checklist still shows the earlier pending entry because Bob updates it separately during the handoff.",
      ],
    };
  },
});
