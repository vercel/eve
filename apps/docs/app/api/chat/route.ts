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

const chatRoute = createChatRoute({
  config,
  sources: [geistdocsSource],
});

export const POST = async (request: Request) => {
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
