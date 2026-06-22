import { realtimeSpeechChannel } from "eve/channels/vercel/speech";
import { agentChannelAuth } from "../channel-auth";

export default realtimeSpeechChannel({
  auth: agentChannelAuth,
  expiresAfterSeconds: 300,
  model: process.env.EVE_REALTIME_MODEL?.trim() || "openai/gpt-realtime-2",
});
