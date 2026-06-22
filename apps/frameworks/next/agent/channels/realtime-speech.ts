import { createGateway } from "@ai-sdk/gateway";
import {
  vercelSpeechChannel,
  type VercelSpeechChannelInput,
  type VercelSpeechGetTokenInput,
} from "eve/channels/vercel/speech";
import { agentChannelAuth } from "../channel-auth";

const gatewayBaseUrl =
  process.env.AI_GATEWAY_BASE_URL?.trim() || process.env.AI_GATEWAY_BASEURL?.trim();
const gatewayBypass =
  process.env.VERCEL_AUTOMATION_BYPASS_SECRET?.trim() || process.env.VERCEL_DPBP?.trim();

const gateway =
  gatewayBaseUrl !== undefined && gatewayBaseUrl.length > 0
    ? createGateway({
        baseURL: gatewayBaseUrl,
        ...(gatewayBypass !== undefined && gatewayBypass.length > 0
          ? { headers: { "x-vercel-protection-bypass": gatewayBypass } }
          : {}),
      })
    : undefined;

function withGatewayBypass(url: string): string {
  if (gatewayBypass === undefined || gatewayBypass.length === 0) return url;
  const parsed = new URL(url);
  parsed.searchParams.set("x-vercel-protection-bypass", gatewayBypass);
  return parsed.toString();
}

export default vercelSpeechChannel({
  auth: agentChannelAuth,
  control:
    process.env.EVE_REALTIME_CONTROL === "1" || process.env.NEXT_PUBLIC_EVE_VOICE_CONTROL === "1",
  expiresAfterSeconds: 300,
  ...(gateway === undefined
    ? {}
    : {
        async getToken(input: VercelSpeechGetTokenInput) {
          const token = await gateway.experimental_realtime.getToken(input);
          return { ...token, url: withGatewayBypass(token.url) };
        },
      }),
  model: process.env.EVE_REALTIME_MODEL?.trim() || "openai/gpt-realtime-2",
} satisfies VercelSpeechChannelInput);
