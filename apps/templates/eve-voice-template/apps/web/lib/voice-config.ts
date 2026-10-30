/** AI Gateway model slug for the realtime voice front end. */
export const LIVE_MODEL = "openai/gpt-live-1";

/** AI Gateway native Live protocol endpoint. */
export const LIVE_WEBSOCKET_URL = "wss://ai-gateway.vercel.sh/v1/live/sessions";

/**
 * Live sessions bill per second, including silence, so the browser ends the
 * call after this long. The token route cannot enforce it: audio flows
 * directly between the browser and AI Gateway.
 */
export const MAX_CALL_SECONDS = 10 * 60;

/**
 * GPT-Live-1 owns listening, speaking, and turn-taking. It delegates every
 * substantive request to the application, which runs it through the eve
 * agent and appends the agent's answer back into the call.
 */
export const LIVE_INSTRUCTIONS = `You are the voice of an assistant built with eve.
You can hold a natural conversation, but you cannot look anything up, remember
facts across calls, or take actions yourself. For anything beyond greetings and
small talk, delegate to the application right away and briefly acknowledge the
request while it works. Never guess or invent an answer: wait for the
application's result, then say it naturally in your own words. If the
application says the agent needs the user's answer, read the question and the
choices to the user, then delegate whatever they reply, even a single word such
as approve or cancel. The user must say the choice's name. Never answer for the
user. Keep every reply short.`;

/**
 * Ephemeral per-turn context for the eve agent. eve does not persist client
 * context, so the agent's instructions stay channel-neutral.
 */
export const VOICE_CLIENT_CONTEXT =
  "This request was spoken during a live voice call and your reply will be read " +
  "aloud by a voice assistant. Answer in one to three short spoken sentences. Do " +
  "not use markdown, lists, tables, code, emoji, or URLs. If you need more " +
  "information, ask one short question.";
