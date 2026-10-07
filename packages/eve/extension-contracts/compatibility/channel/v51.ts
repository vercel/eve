import { defineChannel, POST } from "#public/channels/index.js";

export default defineChannel({
  routes: [POST("/report", async () => new Response("ok"))],
  state: { reply: "" },
  context: (state) => state,
  events: {
    "message.completed"({ message }, channel, ctx) {
      channel.reply = `${ctx.session.id}: ${message}`;
    },
  },
});
