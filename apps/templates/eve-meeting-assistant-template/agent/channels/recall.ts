import { recallChannel } from "@eve/recall";
import { decide } from "eve/ai";

import { replyModeOf } from "../lib/reply-mode.js";
import { VOICE_ENABLED } from "../lib/voice-mode.js";
import { voiceRoutes } from "../lib/voice.js";

// Lines that don't start a turn are kept as recent transcript for the next
// one, so "open a ticket for that" has context.
export default recallChannel({
  // The page the bot shows as its camera, which also plays spoken replies; see `lib/voice.ts`.
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
          instructions: `Is the latest line asking ${botName}, a meeting assistant that manages Linear issues, to do or answer something? The name may be transcribed loosely.`,
        },
      },
      signal: AbortSignal.timeout(3_000),
    });
    return answers.addressed.probability >= 0.5;
  },
  events: {
    async "content.completed"({ data }, { channel }) {
      if (data.kind !== "text" || typeof data.value !== "string") return;
      // With voice off, every reply goes to the chat, as text before a tool call does.
      if (!VOICE_ENABLED) {
        if (data.value.trim()) await channel.recall.sendChatMessage(data.value);
        return;
      }
      // With voice on, the agent tags each message `[voice]`, `[chat]`, or
      // `[both]`; see `lib/reply-mode.ts`. A spoken message also goes to the
      // chat when it has a link, which isn't read aloud. An untagged message,
      // usually the model thinking aloud, only posts for its link.
      const { mode, text } = replyModeOf(data.value);
      if (!text.trim()) return;
      if (mode === "chat" || mode === "both" || /https?:\/\//u.test(text)) {
        await channel.recall.sendChatMessage(text);
      }
    },
  },
});
