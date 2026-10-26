import { defineChannel, POST } from "#public/channels/index.js";

// Epoch 62 had no `history` option, `create()`, or `history.imported` event; epoch 63 adds them, which is additive.
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
