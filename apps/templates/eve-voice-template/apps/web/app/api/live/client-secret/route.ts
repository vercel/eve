import { NextResponse } from "next/server";
import { LIVE_MODEL } from "@/lib/voice-config";
import { hasSameOriginRequest } from "@/lib/password-auth";
import { enforceRateLimit, RateLimitError } from "@/lib/rate-limit";
import { getServerViewer } from "@/lib/session";
import { getSetupStatus } from "@/lib/setup";

const GATEWAY_CLIENT_SECRETS_URL = "https://ai-gateway.vercel.sh/v1/realtime/client-secrets";

/**
 * Mints a single-use AI Gateway client secret so the browser can open the
 * GPT-Live-1 WebSocket directly. Every call is billed by the second, so the
 * route requires a signed-in viewer and is rate limited when Upstash is set.
 */
export async function POST(request: Request) {
  const status = await getSetupStatus();

  if (!status.appReady) {
    return NextResponse.json(
      { error: `Missing configuration: ${status.missing.join(", ")}.` },
      { status: 503 },
    );
  }

  if (!hasSameOriginRequest(request)) {
    return NextResponse.json({ error: "Invalid request origin." }, { status: 403 });
  }

  const viewer = await getServerViewer(status);

  if (!viewer) {
    return NextResponse.json({ error: "Sign in to start a call." }, { status: 401 });
  }

  try {
    await enforceRateLimit({
      key: viewer.id,
      limit: 20,
      prefix: "live-client-secret",
      windowSeconds: 60 * 60,
    });
  } catch (error) {
    if (error instanceof RateLimitError) {
      return NextResponse.json(
        { error: error.message },
        { headers: { "retry-after": String(error.retryAfter) }, status: 429 },
      );
    }
    throw error;
  }

  const response = await fetch(GATEWAY_CLIENT_SECRETS_URL, {
    body: JSON.stringify({ model: LIVE_MODEL, routeKind: "live" }),
    headers: {
      authorization: `Bearer ${process.env.AI_GATEWAY_API_KEY?.trim()}`,
      "content-type": "application/json",
    },
    method: "POST",
  });

  if (!response.ok) {
    console.error("AI Gateway rejected the client secret request", {
      body: await response.text().catch(() => ""),
      status: response.status,
    });
    return NextResponse.json({ error: "Could not start a voice session." }, { status: 502 });
  }

  const { expiresAt, token } = (await response.json()) as {
    readonly expiresAt: number;
    readonly token: string;
  };

  return NextResponse.json({ expiresAt, token }, { headers: { "cache-control": "no-store" } });
}
