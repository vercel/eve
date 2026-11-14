import { defineChannel, POST } from "eve/channels";

import {
  BOT_NAME,
  RECALL_AUTHENTICATOR,
  parseMeetingEvent,
  sendChatMessage,
  verifyRecallWebhook,
} from "../lib/recall.js";

const MAX_WEBHOOK_BYTES = 256 * 1024;

export default defineChannel({
  // Utterances arrive every few seconds. Steering would keep restarting the
  // model, so let each turn finish and batch whatever arrived meanwhile.
  turnPolicy: "queue",

  routes: [
    POST("/recall/webhook", async (request, { from, waitUntil }) => {
      const secret = process.env.RECALL_WORKSPACE_VERIFICATION_SECRET?.trim();
      if (!secret) {
        return new Response("RECALL_WORKSPACE_VERIFICATION_SECRET is not set.", { status: 503 });
      }
      if (Number(request.headers.get("content-length") ?? 0) > MAX_WEBHOOK_BYTES) {
        return new Response("payload too large", { status: 413 });
      }

      const body = await request.text();
      if (!verifyRecallWebhook(request.headers, body, secret)) {
        return new Response("unauthorized", { status: 401 });
      }

      const event = parseMeetingEvent(JSON.parse(body));
      // The bot's own chat messages come back as chat events.
      if (!event || event.speaker === BOT_NAME) return new Response(null, { status: 204 });

      const line =
        event.source === "join"
          ? `${event.speaker} ${event.text}`
          : `${event.speaker}${event.source === "chat" ? " (in chat)" : ""}: ${event.text}`;
      // Recall retries any non-2xx response every second, so acknowledge first.
      waitUntil(
        from(event.botId)
          .send(line, {
            // Speaker names come from the meeting platform and prove nothing,
            // so the whole meeting is one principal. That also lets the queue
            // turn policy batch a burst of utterances into one turn.
            auth: {
              attributes: {},
              authenticator: RECALL_AUTHENTICATOR,
              principalId: `recall:bot:${event.botId}`,
              principalType: "service",
            },
          })
          .catch((error: unknown) => console.error("Recall delivery failed", error)),
      );
      return new Response(null, { status: 204 });
    }),
  ],

  events: {
    async "message.completed"(event, channel) {
      const botId = channel.continuation?.token;
      // Text before a tool call is the agent saying it's starting, so post it too.
      if (!event.message || !botId) return;
      await sendChatMessage(botId, event.message);
    },

    async "turn.failed"(event, channel) {
      const botId = channel.continuation?.token;
      if (event.terminal || !botId) return;
      await sendChatMessage(botId, "Sorry, I hit an error. Please ask again.");
    },
  },
});
