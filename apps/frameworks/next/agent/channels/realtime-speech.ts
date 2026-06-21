import { vercelSpeechChannel } from "eve/channels/vercel/speech";
import { agentChannelAuth } from "../channel-auth";

export default vercelSpeechChannel({
  auth: agentChannelAuth,
  control:
    process.env.EVE_REALTIME_CONTROL === "1" || process.env.NEXT_PUBLIC_EVE_VOICE_CONTROL === "1",
  expiresAfterSeconds: 300,
  model: process.env.EVE_REALTIME_MODEL?.trim() || "openai/gpt-realtime-2",
});
