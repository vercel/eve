import { recallChannel } from "@eve/recall";
import { decide } from "eve/ai";

import { voiceRoutes } from "../lib/voice";

export default recallChannel({
  // The bot's Output Media page plays replies aloud; see `lib/voice.ts`.
  routes: voiceRoutes(),
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
          instructions: `Is the latest line asking ${botName}, a voice assistant in this meeting, to do or answer something? The name may be transcribed loosely.`,
        },
      },
      signal: AbortSignal.timeout(3_000),
    });
    return answers.addressed.probability >= 0.5;
  },
  events: {
    // Replies are spoken, so the chat only gets what people need to read or click.
    async "content.completed"({ data }, { channel }) {
      if (data.kind !== "text" || typeof data.value !== "string") return;
      if (/https?:\/\//u.test(data.value)) await channel.recall.sendChatMessage(data.value);
    },
  },
});
