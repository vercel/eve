import { createLogger } from "#internal/logging.js";
import type { TwilioChannelConfig } from "#public/channels/twilio/twilioChannel.js";
import { verifyTwilioRequest } from "#public/channels/twilio/verify.js";

const log = createLogger("twilio.channel");

export interface TwilioRoutes {
  readonly messages: string;
  readonly transcription: string;
  readonly voice: string;
}

export type TwilioVerifyResult = {
  readonly body: string;
  readonly params: URLSearchParams;
} | null;

export function buildTwilioRoutes(baseRoute: string): TwilioRoutes {
  const base = baseRoute.endsWith("/") ? baseRoute.slice(0, -1) : baseRoute;
  return {
    messages: `${base}/messages`,
    transcription: `${base}/voice/transcription`,
    voice: `${base}/voice`,
  };
}

export async function verifyTwilioInbound(
  req: Request,
  config: TwilioChannelConfig,
): Promise<TwilioVerifyResult> {
  try {
    return await verifyTwilioRequest(req, {
      authToken: config.credentials?.authToken,
      webhookUrl: config.webhookUrl,
    });
  } catch (error) {
    log.warn("twilio inbound verification failed", { error });
    return null;
  }
}

export async function buildTwilioActionUrl(
  request: Request,
  config: TwilioChannelConfig,
  route: string,
): Promise<string> {
  const base =
    typeof config.publicBaseUrl === "function"
      ? await config.publicBaseUrl(request)
      : config.publicBaseUrl;
  if (base) return new URL(route, ensureTrailingSlash(base)).toString();

  const url = new URL(request.url);
  url.pathname = route;
  url.search = "";
  return url.toString();
}

function ensureTrailingSlash(value: string): string {
  return value.endsWith("/") ? value : `${value}/`;
}
