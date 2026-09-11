import { defineState } from "eve/context";
import { defineTool } from "eve/tools";
import { z } from "zod";

const completionMarker = "REPOSITORY_INSPECTION_COMPLETE";
const invocationCount = defineState("compaction-regression.inspect-repository", () => 0);

export default defineTool({
  description:
    "Review the reading-list repository and return an overview of its modules for Alice and Bob's handoff.",
  inputSchema: z.object({
    scope: z.literal("repository"),
  }),
  async execute() {
    const attempt = invocationCount.get() + 1;
    invocationCount.update(() => attempt);

    return {
      completed: true,
      completionMarker,
      workUnit: "repository-inspection",
      hardStop: attempt >= 10,
      attempt,
      findings: [
        "The repository contains a small reading-list application. Its entry point loads the display settings and connects the book catalog, reading lists, previews, and saved-lists page to their repositories.",
        "The catalog module owns book records with identifiers, titles, authors, and shelf labels. Its repository supports title searches and author filters, returning an empty list when a search has no matching records.",
        "The reading-list module stores selected book identifiers in a chosen order. Adding a book already on the list keeps its existing position. A list with no books is a normal starting point for a new selection.",
        "The preview module reads current titles and shelf labels from the catalog. It combines those details with the saved list order, then gives the template the list title, description, and selected books.",
        "The list repository saves the list title and selected books together. It returns a list reference after saving. The preview page then reads that saved record so it displays the same selection when reopened.",
        "Preview templates display book titles and author names as plain text. Each entry includes its shelf label on a separate line. The templates share simple helpers for spacing, headings, and the total book count.",
        "The catalog helper checks that the selected books still have catalog entries. If a title has moved, the preview shows a note beside that entry and leaves the reading list available for a later update.",
        "The preferences module stores the page size and the choice of a compact or spacious layout. A list description is optional. These settings are used consistently on the preview page and the printable version.",
        "The print-view helper receives a saved list reference and prepares a plain page with the same titles. Opening that view leaves the saved reading list unchanged, making it easy to return to the regular preview.",
        "The saved-lists page displays recently prepared lists first. Its repository uses bounded page sizes and a next-page reference. Each entry shows the saved title, book count, and a link to open its preview.",
        "The archive action reads a list's current state before updating it. Selecting the action again leaves an already archived list in the same state. The list can still be found through the archive page.",
        "Alice's repository overview is complete and ready for Bob's handoff. These notes cover finding books, arranging a reading list, viewing saved results, choosing display settings, and preparing a printable copy.",
      ],
    };
  },
});
