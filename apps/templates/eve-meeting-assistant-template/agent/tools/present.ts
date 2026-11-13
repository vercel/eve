import { defineTool } from "eve/tools";
import { z } from "zod";

import { meetingBotId } from "../lib/meeting.js";
import { toPageId, viewUrl } from "../lib/notion.js";
import { ensureNotesPage } from "../lib/notes.js";
import {
  describePage,
  openInBrowser,
  setShownPage,
  shareScreen,
  startStage,
  stopScreenShare,
} from "../lib/stage.js";

export default defineTool({
  description: [
    "Share your browser as your screen in the meeting, or change what's on it.",
    "`notes` opens this meeting's notes page and `doc` another Notion page, live in Notion, so edits from you or anyone else appear as they happen.",
    "`browser` shares whatever your browser shows; drive it with the `browser__` tools, such as a website someone wants to look at together.",
    "`stop` ends the screen share.",
    "The result's `page` has the title and start of what's on screen: if it's a sign-in or no-access screen, follow your instructions for signing in your browser.",
  ].join(" "),
  inputSchema: z.object({
    screen: z.enum(["notes", "doc", "browser", "stop"]),
    page: z.string().optional().describe("For `doc`: the page id or Notion link."),
    follow: z
      .boolean()
      .default(true)
      .describe(
        "For `notes` and `doc`: scroll to each block you edit. Pass false when people ask the view to stay put.",
      ),
  }),
  async execute({ screen, page, follow }, ctx) {
    if (screen === "stop") {
      await stopScreenShare();
      return { sharing: false };
    }
    const botId = meetingBotId(ctx);
    if (botId === undefined) throw new Error("Screen sharing works only inside a meeting.");
    const stage = await startStage(ctx);
    setShownPage(null);
    let url: string | undefined;
    if (screen !== "browser") {
      if (screen === "doc" && !page) throw new Error("Pass `page` to show a doc.");
      const pageId = screen === "notes" ? (await ensureNotesPage()).pageId : toPageId(page!);
      url = await viewUrl(pageId);
      await openInBrowser(ctx, url);
      setShownPage({ pageId, url, follow });
    }
    await shareScreen(botId, stage.url, stage.restarted);
    return { sharing: true, showing: screen, ...(url && { url }), page: await describePage(ctx) };
  },
});
