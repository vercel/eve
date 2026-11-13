import { computer_use } from "eve/extensions/computer-use/tools";
import { defineTool } from "eve/tools";
import { z } from "zod";

import { meetingBotId } from "../lib/meeting.js";
import { toPageId, viewUrl } from "../lib/notion.js";
import { ensureNotesPage } from "../lib/notes.js";
import {
  setShownPage,
  shareScreen,
  startDesktopStage,
  stopDesktopStage,
  stopScreenShare,
} from "../lib/stage.js";

export default defineTool({
  description: [
    "Share your screen in the meeting, or change what's on it.",
    "`notes` shows this meeting's notes page and `doc` shows another Notion page, open in Notion in your desktop's browser, so edits from you or anyone else appear as they happen.",
    "`desktop` shows your computer, which you drive with `computer_use`, such as a website someone wants to look at together.",
    "`stop` ends the screen share.",
  ].join(" "),
  inputSchema: z.object({
    screen: z.enum(["notes", "doc", "desktop", "stop"]),
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
      await stopDesktopStage(ctx);
      return { sharing: false };
    }
    const botId = meetingBotId(ctx);
    if (botId === undefined) throw new Error("Screen sharing works only inside a meeting.");
    let url: string | undefined;
    setShownPage(null);
    if (screen !== "desktop") {
      if (screen === "doc" && !page) throw new Error("Pass `page` to show a doc.");
      const pageId = screen === "notes" ? (await ensureNotesPage()).pageId : toPageId(page!);
      url = await viewUrl(pageId);
      setShownPage({ pageId, url, follow });
    }
    const stage = await startDesktopStage(ctx);
    // Opened through the computer-use tool, so `computer_use` can scroll the same window later.
    if (url)
      await computer_use.execute({ request: { action: "launch", app: "firefox", url } }, ctx);
    await shareScreen(botId, stage);
    return { sharing: true, showing: screen, ...(url && { url }) };
  },
});
