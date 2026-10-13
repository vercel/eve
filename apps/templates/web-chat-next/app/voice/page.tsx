import { VoiceCall } from "@/app/_components/voice-call";

/**
 * In local development `withEve()` runs the agent on its own origin and exposes
 * it via `EVE_BASE_URL`. WebSocket upgrades don't reliably survive the Next.js
 * rewrite, so the voice client connects straight to that origin. In production
 * (agent same-origin behind the rewrite) the client falls back to the page
 * origin.
 */
function resolveVoiceWsUrl(): string | undefined {
  const base = process.env.EVE_BASE_URL;
  if (!base) return undefined;
  const url = new URL("/eve/v1/voice", base);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

export default function VoicePage() {
  return <VoiceCall wsUrl={resolveVoiceWsUrl()} />;
}
