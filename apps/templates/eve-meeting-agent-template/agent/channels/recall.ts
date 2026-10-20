import { decide } from "eve/ai";
import { recallChannel } from "eve/channels/recall";

import { recallWebhookUrl } from "../lib/webhook-url.js";

// Lines that don't start a turn are kept as recent transcript for the next
// one, so "open a ticket for that" has context.
export default recallChannel({
  webhookUrl: recallWebhookUrl(),
  async shouldRespond({ event, line, transcript, botName }) {
    if (event.type === "chat") return true;
    if (event.type !== "speech") return false;
    // Transcription mangles names and people mention the bot in passing, so a
    // fast decision model judges the line against the recent conversation.
    // If it throws or times out, the channel falls back to name matching.
    const { answers } = await decide({
      state: { assistant: botName, recentTranscript: transcript.slice(-10), latest: line },
      questions: {
        addressed: {
          type: "boolean",
          instructions: `Is the latest line asking ${botName}, a meeting assistant that manages Linear issues, to do or answer something? The name may be transcribed loosely.`,
        },
      },
      abortSignal: AbortSignal.timeout(5_000),
    });
    return answers.addressed.probability >= 0.5;
  },
});
