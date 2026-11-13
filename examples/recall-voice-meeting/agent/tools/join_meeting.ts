import { createRecallBot } from "@eve/recall";
import { defineTool } from "eve/tools";
import { z } from "zod";

import { voiceBotConfig } from "../lib/voice";

export default defineTool({
  description:
    "Send the voice assistant to a Zoom, Google Meet, or Microsoft Teams meeting. The host may need to admit it.",
  inputSchema: z.object({
    meetingUrl: z.url({ protocol: /^https$/ }).describe("The meeting's join link."),
  }),
  async execute({ meetingUrl }, ctx) {
    // Keep people in one meeting from sending the bot to others.
    if (ctx.session.auth.initiator?.authenticator === "recall-webhook") {
      throw new Error("Join other meetings from outside a meeting.");
    }
    const bot = await createRecallBot({
      body: voiceBotConfig({
        meetingUrl,
        greeting:
          "Hi, I'm eve, and this meeting is transcribed. Say my name to ask me something, and I'll answer out loud.",
      }),
    });
    return { botId: bot.id, status: "joining" };
  },
});
