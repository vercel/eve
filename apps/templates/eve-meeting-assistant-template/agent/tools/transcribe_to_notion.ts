import { defineTool } from "eve/tools";
import { z } from "zod";

import { startTranscript, stopTranscript } from "../lib/transcript.js";

export default defineTool({
  description:
    'Start or stop a live transcript of the meeting in Notion, a subpage of the notes that gets every line said or typed while it runs, such as when someone says "transcribe this meeting to Notion".',
  inputSchema: z.object({ action: z.enum(["start", "stop"]) }),
  async execute({ action }) {
    return action === "start" ? await startTranscript() : await stopTranscript();
  },
});
