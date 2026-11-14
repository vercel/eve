import { recallChannel, recallMeetingAuth, recallParticipantAuth } from "@eve/recall";
import { decide } from "eve/ai";

import { replyModeOf } from "../lib/reply-mode.js";
import { VOICE_ENABLED } from "../lib/voice-mode.js";
import { recordLine } from "../lib/transcript.js";
import { voiceRoutes } from "../lib/voice.js";

const DECISION_MODEL = process.env.MEETING_DECISION_MODEL?.trim();

/** After this many lines nobody asked eve about, it takes a quiet turn to update the notes. */
const NOTES_EVERY_LINES = 25;

/** Email domains that count as inside the organization, such as `acme.com,acme.io`. Unset allows everyone. */
const internalDomains = (process.env.MEETING_INTERNAL_DOMAINS ?? "")
  .split(",")
  .map((domain) => domain.trim().toLowerCase())
  .filter(Boolean);

// Lines that don't start a turn are kept as recent transcript for the next
// one, so "open a ticket for that" has context.
export default recallChannel({
  // The page the bot shows as its camera, which also plays spoken replies; see `lib/voice.ts`.
  routes: voiceRoutes(),
  async onMeetingEvent({ recall, botName }, event) {
    if (event.type === "status") {
      // Status webhooks come from the Recall dashboard's workspace webhook, pointed at this route.
      if (event.status !== "call_ended") return null;
      return {
        auth: recallMeetingAuth(event),
        message:
          "The meeting ended. Finish the notes: rewrite the summary, and make sure every decision and action item is captured. Don't reply.",
      };
    }
    if (event.participant.name === botName) return null;
    if (event.type === "join" && isExternal(event.participant.email)) {
      // Like Claude Meetings' default: stay out of meetings with outside guests.
      await recall.sendChatMessage(
        "Someone from outside the organization joined, so I'm leaving. The notes so far stay in Notion.",
      );
      await recall.leaveCall();
      return null;
    }
    return { auth: recallParticipantAuth(event) };
  },
  async shouldRespond({ event, line, transcript, botName }) {
    // Every line passes through here in order, so a live transcript records it
    // first. A failed write mustn't change whether eve answers.
    await recordLine(event).catch((error: unknown) => {
      console.warn("Couldn't write the meeting transcript to Notion", error);
    });
    if (event.type === "chat" || event.type === "status") return true;
    if (event.type !== "speech") return false;
    if (transcript.length >= NOTES_EVERY_LINES) return true;
    // Transcription mangles names and people mention the bot in passing, so a
    // fast decision model judges the line against the recent conversation.
    // If it throws or times out, the channel falls back to name matching.
    const { answers } = await decide({
      // Defaults to eve's decision model. Set it when your AI Gateway team doesn't
      // allow that provider, such as `openai/gpt-6-luna-decisions`.
      ...(DECISION_MODEL && { model: DECISION_MODEL }),
      state: { assistant: botName, recentTranscript: transcript.slice(-10), latest: line },
      questions: {
        addressed: {
          type: "boolean",
          instructions: `Is the latest line asking ${botName}, a meeting assistant that takes notes, writes docs, manages Linear issues, looks things up, and shares its screen, to do or answer something? The name may be transcribed loosely.`,
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

function isExternal(email: string | undefined): boolean {
  if (internalDomains.length === 0 || email === undefined) return false;
  const domain = email.split("@").at(-1)?.toLowerCase() ?? "";
  return !internalDomains.includes(domain);
}
