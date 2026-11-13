import { recallChannel } from "@eve/recall";
import { decide } from "eve/ai";

import { replyModeOf } from "../lib/reply-mode";
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
    // The agent tags each message `[voice]`, `[chat]`, or `[both]`; see
    // `lib/reply-mode.ts`. Spoken messages also go to the chat when they have
    // a link, which isn't read aloud.
    async "content.completed"({ data }, { channel }) {
      if (data.kind !== "text" || typeof data.value !== "string") return;
      const { mode, text } = replyModeOf(data.value);
      if (!text.trim()) return;
      // An untagged message, usually the model thinking aloud, only posts for its link.
      if (mode === "chat" || mode === "both" || /https?:\/\//u.test(text)) {
        await channel.recall.sendChatMessage(text);
      }
    },
  },
});
