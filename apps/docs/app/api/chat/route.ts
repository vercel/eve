import { checkRateLimit } from "@vercel/firewall";
import { createChatRoute } from "@vercel/geistdocs/routes/chat";
import {
  analyticsEvents,
  getAskAiContext,
  getDocsSurface,
  getResponseOutcome,
} from "@/lib/analytics/events";
import { trackServerEvent } from "@/lib/analytics/server";
import { config } from "@/lib/geistdocs/config";
import { geistdocsSource } from "@/lib/geistdocs/source";

export const maxDuration = 800;

// Every accepted request runs paid model inference, so the public route needs
// a per-client limit. The limit itself is a Vercel Firewall rate limit rule
// with this ID on the docs project; until that rule exists, checkRateLimit
// logs a warning and lets requests through.
const RATE_LIMIT_ID = "ask-ai";

const chatRoute = createChatRoute({
  config,
  sources: [geistdocsSource],
});

const isRateLimited = async (request: Request) => {
  try {
    const { rateLimited } = await checkRateLimit(RATE_LIMIT_ID, { request });
    return rateLimited;
  } catch (error) {
    // Fail open: a Firewall API problem should not take Ask AI down.
    console.error("[docs chat] rate limit check failed", error);
    return false;
  }
};

export const POST = async (request: Request) => {
  if (await isRateLimited(request)) {
    return Response.json({ error: "Too many requests." }, { status: 429 });
  }

  const analyticsRequest = request.clone();
  const response = await chatRoute.POST(request);
  const body: unknown = await analyticsRequest.json().catch(() => null);

  if (typeof body === "object" && body !== null && "messages" in body) {
    const messages = Array.isArray(body.messages) ? body.messages : [];
    const userTurns = messages.filter(
      (message) =>
        typeof message === "object" &&
        message !== null &&
        "role" in message &&
        message.role === "user",
    ).length;
    const currentRoute = "currentRoute" in body ? body.currentRoute : undefined;
    const hasPageContext = "pageContext" in body && Boolean(body.pageContext);

    trackServerEvent(request, analyticsEvents.askAiSubmitted, {
      context: getAskAiContext(currentRoute, hasPageContext),
      outcome: getResponseOutcome(response.status),
      surface: getDocsSurface(currentRoute),
      turn: userTurns > 1 ? "follow_up" : "first",
    });
  }

  return response;
};
