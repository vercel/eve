import { defineState } from "eve/context";
import { defineTool } from "eve/tools";
import { z } from "zod";

import { SECOND_CHECKPOINT_MARKER } from "../../constants";

const invocationCount = defineState("compaction-regression.advance-checkpoint", () => 0);

export default defineTool({
  description:
    "Record the handoff notes after the initial review is complete and return its checkpoint marker.",
  inputSchema: z.object({
    regressionCase: z.enum(["redundant-tool-calls", "stale-todo-work"]),
  }),
  async execute(input) {
    const attempt = invocationCount.get() + 1;
    invocationCount.update(() => attempt);

    return {
      checkpointMarker: SECOND_CHECKPOINT_MARKER,
      completed: true,
      regressionCase: input.regressionCase,
      attempt,
      handoffNotes: [
        "Alice has finished the initial review of the reading-list application. Bob will use these completed findings for the team handoff. The review and the handoff are separate steps, each with its own saved reference.",
        "The catalog, reading lists, and preview pages form the main sequence. The handoff follows that order so Bob can describe how a book is found in the catalog, added to a list, and shown in a saved preview.",
        "Catalog notes cover book identifiers, titles, authors, and shelf labels. Bob can use that section to explain which details appear in a search result and which details the preview looks up for a selected book.",
        "Reading-list notes cover adding books, arranging their order, and keeping an empty list as a starting point. The examples show how a saved selection can be opened again with the same titles in the same order.",
        "Preview notes describe the list title, optional description, and total book count. Each book entry shows its title and author together, followed by the shelf label. The recorded selection supplies the order of those entries.",
        "The print-view section explains how a saved list becomes a plain page for the library noticeboard. Opening that page leaves the reading list unchanged. Bob can return to the regular preview after preparing the printed copy.",
        "Display preferences cover page size and the compact or spacious layout. An optional description can remain blank. Bob can refer to these examples when explaining how the same list appears in its preview and printable forms.",
        "The saved-lists section describes recent lists and next-page links. The archive section describes how an archived list remains available on its own page. These paragraphs summarize the modules that Alice has already reviewed.",
        "Bob maintains the shared checklist separately from Alice's review. Its pending entry records an earlier checklist state, while the completed findings record the finished review. Bob will bring the checklist up to date during handoff.",
        "The handoff notes are saved, and the checkpoint marker is their reference. Alice and Bob can identify the two completed steps from the review completion marker and the checkpoint marker included in the final report.",
      ],
    };
  },
});
