import { createRecallBot } from "@eve/recall";
import { defineTool } from "eve/tools";
import { z } from "zod";

import { VOICE_ENABLED } from "../lib/voice-mode.js";
import { meetingBotConfig } from "../lib/voice.js";

export default defineTool({
  description:
    "Send the meeting bot to a Zoom, Google Meet, or Microsoft Teams meeting. The host may need to admit it.",
  inputSchema: z.object({
    meetingUrl: z.url({ protocol: /^https$/ }).describe("The meeting's join link."),
  }),
  async execute({ meetingUrl }, ctx) {
    // Keep people in one meeting from sending the bot to others.
    if (ctx.session.auth.initiator?.authenticator === "recall-webhook") {
      throw new Error("Join other meetings from outside a meeting.");
    }
    const bot = await createRecallBot({
      body: meetingBotConfig({
        meetingUrl,
        greeting: VOICE_ENABLED
          ? "Hi, I'm eve, and this meeting is transcribed. Say my name to ask me something or to open or update a Linear issue, and I'll answer out loud."
          : "Hi, I'm eve, and this meeting is transcribed. Say my name or message me here to open or update a Linear issue.",
      }),
    });
    return { botId: bot.id, status: "joining" };
  },
});
