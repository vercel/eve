import type { ScenarioAppDescriptor } from "#internal/testing/scenario-app.js";

export const CUSTOM_CHANNEL_PORTABILITY_DESCRIPTOR: ScenarioAppDescriptor = {
  files: {
    "agent/channels/dashboard.ts": `import { defineChannel, POST, GET } from "eve/channels";

export default defineChannel({
  state: { lastSender: "" },

  context(state) {
    return { sender: state.lastSender };
  },

  routes: [
    POST("/api/message", async (req, { from }) => {
      const body = await req.json();
      const session = await from("test:" + crypto.randomUUID()).send(body.message, {
        auth: null,
        state: { lastSender: body.userId ?? "anonymous" },
      });
      return Response.json({ sessionId: session.id });
    }),

    GET("/api/stream/:sessionId", async (req, { attachSession, params }) => {
      const session = attachSession(params.sessionId);
      const events = await session.getEventStream();
      return new Response(events, { headers: { "content-type": "text/event-stream" } });
    }),
  ],

  events: {
    "message.completed"(event, ctx) {
      if (event.finishReason === "tool-calls") return;
      console.log("Reply from", ctx.sender, ":", event.message);
    },
  },
});
`,
  },
  name: "custom-channel-portability",
};
